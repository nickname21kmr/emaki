import { performance } from 'node:perf_hooks';
/**
 * 未识别（T15 → T34a 契约 v3）：两个大类（插画和漫画 / 照片、文字等）、四个分段、「没认出」按主题分组，以及采纳建议。
 * 用键集分页：用户一边翻一边处理，偏移分页会跳过同样数量的图。计数全部来自缓存的汇总（summary），不每页重算（RV-T-9）。
 */
import {
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_THEMES,
  type ID,
  type ListUnrecognizedQuery,
  type ListUnrecognizedResponse,
  type MutationResult,
  type UnrecognizedAnnexKind,
  type UnrecognizedSummary,
  type UnrecognizedTheme,
} from '@emaki/shared';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { insertDanbooruCharacter } from './characters.ts';
import type { SqliteContext } from './context.ts';
import { applyExclusionRules } from './exclusions.ts';
import { loadImageItems } from './hydrate.ts';
import { ANNEX_KINDS_SQL, ART_KINDS_SQL, decodeCursor, encodeCursor, iso, parseId, QUEUE, THEME_EXPR, UNRECOGNIZED } from './sql.ts';
import { loadSuggestions } from './suggestions.ts';

/**
 * 每行的排序键：a 入库时间、tg 识别时间、sh 放下时间、c 是否漫画、t 最高建议分（没有 = -1）、
 * s 像插画的程度（没识别 = -999）、th 主题（查询时叠加漫画 / 不像插画 / 敏感）
 */
const COLS = `i.id, i.added_at AS a, i.tagged_at AS tg, i.shelved_at AS sh, (i.content_kind = 'comic') AS c,
    COALESCE((SELECT MAX(s.score) FROM character_suggestions s WHERE s.image_id = i.id), -1) AS t,
    COALESCE(i.art_score, -999) AS s, ${THEME_EXPR} AS th`;
/** 插画和漫画：没有角色、不在合集里（合集整本处理），放下的也在这里（由分段区分） */
const ROW_ART = `SELECT ${COLS} FROM v_counted_images i WHERE ${ART_KINDS_SQL} AND ${UNRECOGNIZED} AND i.collection_id IS NULL`;
/** 照片、文字等：没有角色的别册图 */
const ROW_ANNEX = `SELECT ${COLS} FROM v_counted_images i WHERE ${ANNEX_KINDS_SQL} AND ${UNRECOGNIZED}`;
/** 「用主模型重新识别」的范围：队列里识别过、没认出角色的插画（漫画按本处理，放下的是用户自己的决定，都不动） */
const RETAGGABLE = `FROM v_counted_images i WHERE ${QUEUE} AND i.tagged_at IS NOT NULL AND i.content_kind = 'illustration'`;

/** 分段条件（作用在 ROW 结果上）。漫画不等识别，直接算「没认出」（RV-T-1 ②） */
const BUCKET_WHERE = {
  all: 'sh IS NULL',
  suggested: 'sh IS NULL AND t >= 0',
  unsure: 'sh IS NULL AND t < 0 AND (tg IS NOT NULL OR c = 1)',
  untagged: 'sh IS NULL AND t < 0 AND tg IS NULL AND c = 0',
  shelved: 'sh IS NOT NULL',
} as const;

/**
 * 排序模式：
 * - triage（有建议 / 待识别 / 不分段）：插画在漫画前，最高建议分倒序，再按入库时间倒序（TR-2）
 * - art（没认出）：插画在漫画前，越像插画越靠前
 * - shelf（放下的）：最近放下的在前
 * - annex（照片、文字等）：最新入库在前
 */
type Mode = 'triage' | 'art' | 'shelf' | 'annex';
const ORDER: Record<Mode, { order: string; after: string; ok: (c: Record<string, unknown>) => boolean }> = {
  triage: {
    order: 'c ASC, t DESC, a DESC, id DESC',
    after: '@c IS NULL OR c > @c OR (c = @c AND (t < @t OR (t = @t AND (a < @a OR (a = @a AND id < @i)))))',
    ok: (c) => (c.c === 0 || c.c === 1) && typeof c.t === 'number' && typeof c.a === 'string',
  },
  art: {
    order: 'c ASC, s DESC, id DESC',
    after: '@c IS NULL OR c > @c OR (c = @c AND (s < @s OR (s = @s AND id < @i)))',
    ok: (c) => (c.c === 0 || c.c === 1) && typeof c.s === 'number',
  },
  shelf: {
    order: 'sh DESC, id DESC',
    after: '@a IS NULL OR sh < @a OR (sh = @a AND id < @i)',
    ok: (c) => typeof c.a === 'string',
  },
  annex: {
    order: 'a DESC, id DESC',
    after: '@a IS NULL OR a < @a OR (a = @a AND id < @i)',
    ok: (c) => typeof c.a === 'string',
  },
};

interface Row {
  id: number;
  a: string;
  tg: string | null;
  sh: string | null;
  c: 0 | 1;
  t: number;
  s: number;
  th: UnrecognizedTheme;
}

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export class UnrecognizedQueries {
  private cached: UnrecognizedSummary | null = null;

  constructor(
    private readonly ctx: SqliteContext,
    private readonly catalog: () => CharacterCatalog,
    private readonly softMs = 0,
  ) {}

  /** 写操作、扫描、识别之后清缓存（SqliteDataSource 接 onInvalidate 和 library-changed） */
  invalidate(soft = false): void {
    // 软失效：汇总最多晚 SOFT_MS 更新（识别期间侧栏数字不必每 5 秒重算一遍）
    if (soft && this.cached) this.softAt ??= performance.now();
    else {
      this.cached = null;
      this.softAt = null;
    }
  }
  private softAt: number | null = null;

  /** 两个大类、四个分段、十个主题、五类别册的张数，一条语句算完并缓存 */
  summary(): UnrecognizedSummary {
    if (this.cached && (this.softAt === null || performance.now() - this.softAt < this.softMs)) return this.cached;
    this.softAt = null;
    const rows = this.ctx
      .stmt(
        `SELECT CASE
            WHEN i.content_kind NOT IN ('illustration','comic') THEN i.content_kind
            WHEN i.shelved_at IS NOT NULL THEN 'shelved'
            WHEN EXISTS (SELECT 1 FROM character_suggestions s WHERE s.image_id = i.id) THEN 'suggested'
            WHEN i.content_kind = 'comic' THEN 'comic'
            WHEN i.tagged_at IS NULL THEN 'untagged'
            ELSE ${THEME_EXPR} END AS k, COUNT(*) AS n
         FROM v_counted_images i
         WHERE ${UNRECOGNIZED} AND (${ANNEX_KINDS_SQL} OR i.collection_id IS NULL)
         GROUP BY 1`,
      )
      .all() as { k: string; n: number }[];
    const got = new Map(rows.map((r) => [r.k, r.n]));
    const n = (k: string) => got.get(k) ?? 0;
    const themes = zeros(UNRECOGNIZED_THEMES);
    for (const t of UNRECOGNIZED_THEMES) themes[t] = n(t);
    const kinds = zeros(UNRECOGNIZED_ANNEX_KINDS);
    for (const k of UNRECOGNIZED_ANNEX_KINDS) kinds[k] = n(k);
    const unsure = UNRECOGNIZED_THEMES.reduce((sum, t) => sum + themes[t], 0);
    const retaggable = (this.ctx.stmt(`SELECT COUNT(*) AS n ${RETAGGABLE}`).get() as { n: number }).n;
    const art = { suggested: n('suggested'), unsure, untagged: n('untagged'), shelved: n('shelved'), themes, retaggable };
    this.cached = {
      art: { total: art.suggested + art.unsure + art.untagged, ...art },
      annex: { total: UNRECOGNIZED_ANNEX_KINDS.reduce((sum, k) => sum + kinds[k], 0), kinds },
    };
    return this.cached;
  }

  /** 把「用主模型重新识别」范围里的图标记为 retag = 1，返回张数；识别任务写库时清零 */
  markRetag(): number {
    return this.ctx.stmt(`UPDATE images SET retag = 1 WHERE id IN (SELECT i.id ${RETAGGABLE}) AND retag = 0`).run().changes;
  }

  list(q: ListUnrecognizedQuery): ListUnrecognizedResponse {
    const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
    const sum = this.summary();
    const annex = q.area === 'annex';
    // 参数和大类不匹配时一律忽略（theme 只在 art + unsure 时生效，RV-T-8）
    const bucket = annex ? null : (q.bucket ?? null);
    const theme = !annex && bucket === 'unsure' ? (q.theme ?? null) : null;
    const kind: UnrecognizedAnnexKind | null = annex ? (q.kind ?? null) : null;
    const mode: Mode = annex ? 'annex' : bucket === 'shelved' ? 'shelf' : bucket === 'unsure' ? 'art' : 'triage';
    const m = ORDER[mode];
    const c = decodeCursor(q.cursor, (x): x is Record<string, unknown> => {
      const v = x as Record<string, unknown>;
      return typeof x === 'object' && x !== null && v.m === mode && Number.isInteger(v.i) && (v.i as number) > 0 && m.ok(v);
    });

    const where = annex
      ? kind
        ? 'i.content_kind = @kind'
        : '1'
      : `${BUCKET_WHERE[bucket ?? 'all']}${theme ? ' AND th = @theme' : ''}`;
    const sql = annex
      ? `SELECT * FROM (${ROW_ANNEX} AND ${where}) WHERE ${m.after} ORDER BY ${m.order} LIMIT @take`
      : `SELECT * FROM (${ROW_ART}) WHERE ${where} AND (${m.after}) ORDER BY ${m.order} LIMIT @take`;
    const rows = this.ctx.stmt(sql).all({
      kind,
      theme,
      c: c?.c ?? null,
      t: c?.t ?? null,
      s: c?.s ?? null,
      a: c?.a ?? null,
      i: c?.i ?? null,
      take: limit + 1,
    }) as Row[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const total = annex
      ? kind
        ? sum.annex.kinds[kind]
        : sum.annex.total
      : theme
        ? sum.art.themes[theme]
        : bucket
          ? sum.art[bucket]
          : sum.art.total;

    const ids = rows.map((r) => r.id);
    const items = loadImageItems(this.ctx.db, ids);
    const suggestions = loadSuggestions(this.ctx, ids, this.catalog());
    const last = rows.at(-1);
    const cursorOf = (r: Row) =>
      mode === 'triage'
        ? { m: mode, c: r.c, t: r.t, a: r.a, i: r.id }
        : mode === 'art'
          ? { m: mode, c: r.c, s: r.s, i: r.id }
          : { m: mode, a: mode === 'shelf' ? r.sh : r.a, i: r.id };
    return {
      items: items.map((image, k) => ({
        image,
        suggestions: suggestions.get(ids[k]!) ?? [],
        tagged: rows[k]!.tg !== null,
      })),
      nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
      total,
      suggestedCount: sum.art.suggested,
      unsureCount: sum.art.unsure,
      untaggedCount: sum.art.untagged,
      annexCount: sum.annex.total,
    };
  }

  accept(imageIdStr: ID, rawTag: string): MutationResult {
    const imageId = parseId(imageIdStr);
    if (imageId === null || !this.ctx.stmt('SELECT 1 FROM v_images WHERE id = ?').get(imageId)) throw new NotFoundError('图片');
    const tag = rawTag.trim();
    if (!tag) throw new BadRequestError('标签不能为空');
    const score = (this.ctx.stmt('SELECT score FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?').pluck().get(imageId, tag) ??
      null) as number | null;
    const catalog = this.catalog();
    const db = this.ctx.db;
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      u.set('character_suggestions', 'image_id = ? AND danbooru_tag = ?', [imageId, tag]);
      u.columns('images', ['excluded_by'], [imageId]);
      let characterId = catalog.resolveCharacterId(tag);
      let created = false;
      if (characterId === null) {
        // 新建角色（封面由 derived 自动选）；和自动采纳一样按作品挂好（必要时新建作品），撤销时一并删除
        const r = insertDanbooruCharacter(u, catalog, tag, { now });
        characterId = r.id;
        created = r.created;
      }
      const ins = db
        .prepare("INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'manual', ?, ?)")
        .run(imageId, characterId, score, now);
      if (ins.changes === 1) u.sql('DELETE FROM image_characters WHERE image_id = ? AND character_id = ?', [imageId, characterId]);
      db.prepare('DELETE FROM character_suggestions WHERE image_id = ? AND danbooru_tag = ?').run(imageId, tag);
      applyExclusionRules(this.ctx, { imageIds: [imageId] }); // 新角色可能命中「角色」排除规则
      const name = db.prepare('SELECT name FROM characters WHERE id = ?').pluck().get(characterId) as string;
      return { message: created ? `已新建角色「${name}」并归入` : `已归到「${name}」` };
    });
  }
}
