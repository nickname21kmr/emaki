import { performance } from 'node:perf_hooks';
/**
 * 未识别（T15 → T34a 契约 v3）：两个大类（插画和漫画 / 照片、文字等）、四个分段、「没认出」按主题分组，以及采纳建议。
 * 用键集分页：用户一边翻一边处理，偏移分页会跳过同样数量的图。计数全部来自缓存的汇总（summary），不每页重算（RV-T-9）。
 *
 * 列表从读进内存的整个队列里切（Queue，和汇总同一个失效开关）。以前每一页都把整个队列查一遍，收拢组图时还要整体分组、开窗、
 * 再数一遍格数：2.6 万张的队列每页 0.4–0.6 秒，整理时每处理一张，已经翻过的每一页都这样重来。
 * 现在整个队列读一次约 0.1 秒，之后每一页只剩取这一页的详情和建议。
 */
import {
  AUTO_COLLAPSE_MIN,
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_ART_KINDS,
  UNRECOGNIZED_THEMES,
  type CollectionKind,
  type ContentKind,
  type ListUnrecognizedQuery,
  type ListUnrecognizedResponse,
  type UnrecognizedAnnexKind,
  type UnrecognizedArea,
  type UnrecognizedArtCounts,
  type UnrecognizedArtKind,
  type UnrecognizedBucket,
  type UnrecognizedSummary,
  type UnrecognizedTheme,
} from '@emaki/shared';
import { CharacterCatalog } from '../../domain/catalog/characterCatalog.ts';
import { markRetag } from '../../domain/evidence/retag.ts';
import type { SqliteContext } from './context.ts';
import { loadImageItems } from './hydrate.ts';
import {
  ANNEX_KINDS_SQL,
  ANNEX_QUEUE,
  ART_KINDS_SQL,
  ART_QUEUE_SCOPE,
  ILLUSTRATION,
  QUEUE,
  THEME_EXPR,
  UNRECOGNIZED,
} from '../../readmodel/terms.ts';
import { decodeCursor, encodeCursor } from './sql.ts';
import { loadSuggestions } from './suggestions.ts';

/**
 * 每行的排序键：a 入库时间、tg 识别时间、sh 放下时间、c 是否漫画、t 最高建议分（没有 = -1）、
 * s 像插画的程度（没识别 = -999）、th 主题（查询时叠加漫画 / 不像插画 / 敏感）
 */
const COLS = `i.id, i.added_at AS a, i.tagged_at AS tg, i.shelved_at AS sh, (i.content_kind = 'comic') AS c,
    COALESCE((SELECT MAX(s.score) FROM v_character_suggestions s WHERE s.image_id = i.id), -1) AS t,
    COALESCE(i.art_score, -999) AS s, ${THEME_EXPR} AS th`;
/** 「插画 · 漫画」队列的范围里没认出的（漫画页看设置；合集里的页整本处理、漫画区不找角色，都不在这里），放下的也在这里（由分段区分） */
const ROW_ART = `SELECT ${COLS} FROM v_counted_images i WHERE ${ART_QUEUE_SCOPE} AND ${UNRECOGNIZED}`;
/** 「照片 · 文字等」队列 */
const ROW_ANNEX = `SELECT ${COLS} FROM v_counted_images i WHERE ${ANNEX_QUEUE}`;
/** 「用主模型重新识别」的范围：队列里识别过、没认出角色的插画（漫画按本处理，放下的是用户自己的决定，都不动） */
const RETAGGABLE = `FROM v_counted_images i WHERE ${QUEUE} AND i.tagged_at IS NOT NULL AND ${ILLUSTRATION}`;

/**
 * 读进内存的队列每行取的列：id、排序键（和 COLS 同样的表达式）、识别过没有、类型（只看插画 / 漫画、别册的类型筛它）、
 * 所在的组图（active 的组图合集，不在组图里是空）。
 * 不取收藏、分级、主题：收藏、改分级不改变队列里有谁、怎么排，这份缓存那时候不清，所以不能放跟着它们变的东西——
 * 一组是不是都收藏了、整组几张，取到这一页时现查；主题里的「敏感」看分级，筛主题时现查
 */
const QUEUE_COLS = `i.id, i.added_at AS a, (i.tagged_at IS NOT NULL) AS tagged, i.shelved_at AS sh, (i.content_kind = 'comic') AS c,
    COALESCE((SELECT MAX(s.score) FROM v_character_suggestions s WHERE s.image_id = i.id), -1) AS t,
    COALESCE(i.art_score, -999) AS s, i.content_kind AS k,
    (SELECT g.id FROM collections g WHERE g.id = i.collection_id AND g.state = 'active' AND g.kind = 'group') AS g`;
/** 两个大类的整个队列（范围同 ROW_ART / ROW_ANNEX） */
const QUEUE_SQL: Record<UnrecognizedArea, string> = {
  art: `SELECT ${QUEUE_COLS} FROM v_counted_images i WHERE ${ART_QUEUE_SCOPE} AND ${UNRECOGNIZED}`,
  annex: `SELECT ${QUEUE_COLS} FROM v_counted_images i WHERE ${ANNEX_QUEUE}`,
};

/** 读进内存的队列里的一行 */
interface QueueRow {
  id: number;
  a: string;
  tagged: 0 | 1;
  sh: string | null;
  c: 0 | 1;
  t: number;
  s: number;
  k: ContentKind;
  g: number | null;
}
/** 排序键：内存里的行、SQL 取出来的行、游标里记的那一行都给得出 */
type Keys = Pick<QueueRow, 'id' | 'a' | 'sh' | 'c' | 't' | 's'>;

/** 分段条件（作用在 ROW 结果上）。漫画不等识别，直接算「没认出」（RV-T-1 ②） */
const BUCKET_WHERE = {
  all: 'sh IS NULL',
  suggested: 'sh IS NULL AND t >= 0',
  unsure: 'sh IS NULL AND t < 0 AND (tg IS NOT NULL OR c = 1)',
  untagged: 'sh IS NULL AND t < 0 AND tg IS NULL AND c = 0',
  shelved: 'sh IS NOT NULL',
} as const;
/** 同 BUCKET_WHERE，对内存里的行判断 */
const BUCKET_KEEP: Record<keyof typeof BUCKET_WHERE, (r: QueueRow) => boolean> = {
  all: (r) => r.sh === null,
  suggested: (r) => r.sh === null && r.t >= 0,
  unsure: (r) => r.sh === null && r.t < 0 && (r.tagged === 1 || r.c === 1),
  untagged: (r) => r.sh === null && r.t < 0 && r.tagged === 0 && r.c === 0,
  shelved: (r) => r.sh !== null,
};

/** 文本从小到大：和 SQLite 默认的比较一样逐个字符比（这里比的都是 ISO 时间）；空的排最小 */
const text = (x: string | null, y: string | null) => {
  const p = x ?? '';
  const q = y ?? '';
  return p < q ? -1 : p > q ? 1 : 0;
};

/**
 * 排序模式：
 * - triage（有建议 / 待识别 / 不分段）：插画在漫画前，最高建议分倒序，再按入库时间倒序（TR-2）
 * - art（没认出）：插画在漫画前，越像插画越靠前
 * - shelf（放下的）：最近放下的在前
 * - annex（照片、文字等）：最新入库在前
 *
 * order / after 是 SQL 的写法；cmp 是同一个顺序在内存里比（逐项照 order 写，排在前面的小于 0），
 * 内存里「在游标之后」就是 cmp(行, 游标) > 0
 */
type Mode = 'triage' | 'art' | 'shelf' | 'annex';
const ORDER: Record<Mode, { order: string; after: string; ok: (c: Record<string, unknown>) => boolean; cmp: (x: Keys, y: Keys) => number }> = {
  triage: {
    order: 'c ASC, t DESC, a DESC, id DESC',
    after: '@c IS NULL OR c > @c OR (c = @c AND (t < @t OR (t = @t AND (a < @a OR (a = @a AND id < @i)))))',
    ok: (c) => (c.c === 0 || c.c === 1) && typeof c.t === 'number' && typeof c.a === 'string',
    cmp: (x, y) => x.c - y.c || y.t - x.t || text(y.a, x.a) || y.id - x.id,
  },
  art: {
    order: 'c ASC, s DESC, id DESC',
    after: '@c IS NULL OR c > @c OR (c = @c AND (s < @s OR (s = @s AND id < @i)))',
    ok: (c) => (c.c === 0 || c.c === 1) && typeof c.s === 'number',
    cmp: (x, y) => x.c - y.c || y.s - x.s || y.id - x.id,
  },
  shelf: {
    order: 'sh DESC, id DESC',
    after: '@a IS NULL OR sh < @a OR (sh = @a AND id < @i)',
    ok: (c) => typeof c.a === 'string',
    cmp: (x, y) => text(y.sh, x.sh) || y.id - x.id,
  },
  annex: {
    order: 'a DESC, id DESC',
    after: '@a IS NULL OR a < @a OR (a = @a AND id < @i)',
    ok: (c) => typeof c.a === 'string',
    cmp: (x, y) => text(y.a, x.a) || y.id - x.id,
  },
};

/** 游标里记的那一行的排序键（cursorOf 的反向；这个模式用不到的键随便填，不参与比较） */
const cursorKeys = (mode: Mode, c: Record<string, unknown>): Keys => ({
  id: c.i as number,
  a: mode === 'shelf' ? '' : ((c.a as string | undefined) ?? ''),
  sh: mode === 'shelf' ? (c.a as string) : null,
  c: (c.c as 0 | 1 | undefined) ?? 0,
  t: (c.t as number | undefined) ?? 0,
  s: (c.s as number | undefined) ?? 0,
});

/** 一个大类的整个队列；sorted 是按各排序模式排好的（用到才排，只排一次） */
interface Queue {
  rows: QueueRow[];
  sorted: Partial<Record<Mode, QueueRow[]>>;
}

/** 收拢后一格的组图信息（同 ImageItem.collectionGroup，id 还是数字） */
interface PageGroup {
  id: number;
  title: string | null;
  kind: CollectionKind;
  count: number;
  total: number;
  allFavorite: boolean;
  memberIds: number[];
}
/** 取出来的一页里的一行：排序键（下一页的游标用），收拢时带这一格的组图 */
type PageRow = Keys & { group?: PageGroup };
interface PageSlice {
  rows: PageRow[];
  hasMore: boolean;
  /** 收拢后的格数（不收拢时没有） */
  displayTotal?: number;
}
/** 列表的筛选（参数和大类不匹配的已经去掉） */
interface Filter {
  annex: boolean;
  bucket: UnrecognizedBucket | null;
  theme: UnrecognizedTheme | null;
  kind: UnrecognizedAnnexKind | null;
  artKind: UnrecognizedArtKind | null;
}

/**
 * 收拢组图：同一组在 pool（已经筛好、按当前顺序排好）里只留排在最前的那张当代表。返回每一格的那一行，和各组在 pool 里的成员。
 * 是在筛过分段、主题之后的范围里分组：一组里有的有建议、有的没认出时，这一组在两个分段里各占一格
 */
function collapseGroups(pool: QueueRow[]): { cells: QueueRow[]; members: Map<number, number[]> } {
  const members = new Map<number, number[]>();
  const cells: QueueRow[] = [];
  for (const row of pool) {
    if (row.g === null) {
      cells.push(row);
      continue;
    }
    const list = members.get(row.g);
    if (list) list.push(row.id);
    else {
      members.set(row.g, [row.id]);
      cells.push(row);
    }
  }
  return { cells, members };
}

/** 排好序的一列里，排在游标之后的第一个位置 */
function firstAfter(list: QueueRow[], cmp: (x: Keys, y: Keys) => number, cursor: Keys): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(list[mid]!, cursor) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 测试用：强制走 SQL 的写法（每页现查整个队列），拿来和读进内存的队列逐页对比 */
let sqlForTests = false;
export const useSqlQueueForTests = (on: boolean) => {
  sqlForTests = on;
};

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** 汇总缓存：按「类型|分组」计的张数（分组见 summary 里的 CASE），加上重新识别的范围 */
interface Counts {
  got: Map<string, number>;
  retaggable: number;
}

export class UnrecognizedQueries {
  private cached: Counts | null = null;
  /** 读进内存的队列，按大类；用到才读 */
  private queues: Partial<Record<UnrecognizedArea, Queue>> = {};

  constructor(
    private readonly ctx: SqliteContext,
    private readonly catalog: () => CharacterCatalog,
    private readonly softMs = 0,
  ) {}

  /** 写操作、扫描、识别之后清缓存（SqliteDataSource 接 onInvalidate，由变更传播的提交后反应调用） */
  invalidate(soft = false): void {
    // 软失效只推迟汇总（识别期间侧栏数字不必每几秒重算）；队列直接丢，下一页重读（约 0.1 秒），
    // 列表不跟着晚：任务结束那次推送之后没有别的事件，旧队列会一直留着
    this.queues = {};
    if (soft && this.cached) this.softAt ??= performance.now();
    else this.drop();
  }
  private softAt: number | null = null;

  private drop(): void {
    this.cached = null;
    this.queues = {};
    this.softAt = null;
  }

  /** 软失效之后过了 softMs：旧的汇总不再用（队列在软失效时已经丢了） */
  private expire(): void {
    if (this.softAt !== null && performance.now() - this.softAt >= this.softMs) this.drop();
  }

  /** 按类型和分组的张数，一条语句算完并缓存 */
  private counts(): Counts {
    this.expire();
    if (this.cached) return this.cached;
    const rows = this.ctx
      .stmt(
        `SELECT i.content_kind AS ck, CASE
            WHEN NOT ${ART_KINDS_SQL} THEN i.content_kind
            WHEN i.shelved_at IS NOT NULL THEN 'shelved'
            WHEN EXISTS (SELECT 1 FROM v_character_suggestions s WHERE s.image_id = i.id) THEN 'suggested'
            WHEN i.content_kind = 'comic' THEN 'comic'
            WHEN i.tagged_at IS NULL THEN 'untagged'
            ELSE ${THEME_EXPR} END AS k, COUNT(*) AS n
         FROM v_counted_images i
         WHERE ${UNRECOGNIZED} AND (${ANNEX_KINDS_SQL} OR (${ART_QUEUE_SCOPE}))
         GROUP BY 1, 2`,
      )
      .all() as { ck: string; k: string; n: number }[];
    const retaggable = (this.ctx.stmt(`SELECT COUNT(*) AS n ${RETAGGABLE}`).get() as { n: number }).n;
    this.cached = { got: new Map(rows.map((r) => [`${r.ck}|${r.k}`, r.n])), retaggable };
    return this.cached;
  }

  /** 一个大类的整个队列：读一次放着，到下次失效 */
  private queue(area: UnrecognizedArea): Queue {
    this.expire();
    return (this.queues[area] ??= { rows: this.ctx.stmt(QUEUE_SQL[area]).all() as QueueRow[], sorted: {} });
  }

  /** 两个大类、四个分段、十个主题、四类别册的张数；artKind 只算插画或漫画（retaggable、art.kinds、annex 不变） */
  summary(artKind?: UnrecognizedArtKind): UnrecognizedSummary {
    const { got, retaggable } = this.counts();
    const n = (cks: readonly string[], k: string) => cks.reduce((sum, ck) => sum + (got.get(`${ck}|${k}`) ?? 0), 0);
    const artOf = (cks: readonly string[]) => {
      const themes = zeros(UNRECOGNIZED_THEMES);
      for (const t of UNRECOGNIZED_THEMES) themes[t] = n(cks, t);
      const unsure = UNRECOGNIZED_THEMES.reduce((sum, t) => sum + themes[t], 0);
      const c = { suggested: n(cks, 'suggested'), unsure, untagged: n(cks, 'untagged'), shelved: n(cks, 'shelved') };
      return { counts: { total: c.suggested + c.unsure + c.untagged, ...c } satisfies UnrecognizedArtCounts, themes };
    };
    const kinds = zeros(UNRECOGNIZED_ANNEX_KINDS);
    for (const k of UNRECOGNIZED_ANNEX_KINDS) kinds[k] = n([k], k);
    const artKinds = Object.fromEntries(UNRECOGNIZED_ART_KINDS.map((k) => [k, artOf([k]).counts])) as Record<UnrecognizedArtKind, UnrecognizedArtCounts>;
    const art = artOf(artKind ? [artKind] : UNRECOGNIZED_ART_KINDS);
    return {
      art: { ...art.counts, themes: art.themes, retaggable, kinds: artKinds },
      annex: { total: UNRECOGNIZED_ANNEX_KINDS.reduce((sum, k) => sum + kinds[k], 0), kinds },
    };
  }

  /** 把「用主模型重新识别」范围里的图标记为 retag = 1（证据模块），返回张数；识别任务写库时清零 */
  markRetag(): number {
    return markRetag(this.ctx.db, this.ctx.stmt(`SELECT i.id ${RETAGGABLE}`).pluck().all() as number[]);
  }

  list(q: ListUnrecognizedQuery): ListUnrecognizedResponse {
    const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
    const annex = q.area === 'annex';
    // 参数和大类不匹配时一律忽略（theme 只在 art + unsure 时生效，RV-T-8）
    const artKind = annex ? null : (q.artKind ?? null);
    const sum = this.summary(artKind ?? undefined);
    const bucket = annex ? null : (q.bucket ?? null);
    const theme = !annex && bucket === 'unsure' ? (q.theme ?? null) : null;
    const kind: UnrecognizedAnnexKind | null = annex ? (q.kind ?? null) : null;
    const mode: Mode = annex ? 'annex' : bucket === 'shelved' ? 'shelf' : bucket === 'unsure' ? 'art' : 'triage';
    const m = ORDER[mode];
    const c = decodeCursor(q.cursor, (x): x is Record<string, unknown> => {
      const v = x as Record<string, unknown>;
      return typeof x === 'object' && x !== null && v.m === mode && Number.isInteger(v.i) && (v.i as number) > 0 && m.ok(v);
    });

    const total = annex
      ? kind
        ? sum.annex.kinds[kind]
        : sum.annex.total
      : theme
        ? sum.art.themes[theme]
        : bucket
          ? sum.art[bucket]
          : sum.art.total;

    // 'auto'：第一页看张数，翻页沿用第一页的决定（游标里的 g）
    const collapse =
      q.collapseCollections === 'auto' ? (c ? c.g === 1 : total > AUTO_COLLAPSE_MIN) : !!q.collapseCollections;
    const filter: Filter = { annex, bucket, theme, kind, artKind };
    const page = sqlForTests ? this.pageFromSql(filter, mode, collapse, c, limit) : this.pageFromQueue(filter, mode, collapse, c, limit);

    const ids = page.rows.map((r) => r.id);
    const images = new Map(loadImageItems(this.ctx.db, ids).map((image) => [image.id, image]));
    const suggestions = loadSuggestions(this.ctx, ids, this.catalog());
    const last = page.rows.at(-1);
    const g = collapse ? { g: 1 } : {};
    const cursorOf = (r: Keys) =>
      mode === 'triage'
        ? { m: mode, c: r.c, t: r.t, a: r.a, i: r.id, ...g }
        : mode === 'art'
          ? { m: mode, c: r.c, s: r.s, i: r.id, ...g }
          : { m: mode, a: mode === 'shelf' ? r.sh : r.a, i: r.id, ...g };
    return {
      items: page.rows.flatMap((r) => {
        // 队列是缓存的（后台任务写库后最多晚 softMs）：这期间图的行没了就跳过
        const image = images.get(String(r.id));
        if (!image) return [];
        const group = r.group;
        return [
          {
            image: group
              ? {
                  ...image,
                  collectionGroup: {
                    id: String(group.id),
                    title: group.title,
                    kind: group.kind,
                    count: group.count,
                    total: group.total,
                    allFavorite: group.allFavorite,
                    memberIds: group.memberIds.map(String),
                  },
                }
              : image,
            suggestions: suggestions.get(r.id) ?? [],
            tagged: image.tagged,
          },
        ];
      }),
      ...(collapse ? { displayTotal: page.displayTotal, collapsed: true } : {}),
      nextCursor: page.hasMore && last ? encodeCursor(cursorOf(last)) : null,
      total,
      suggestedCount: sum.art.suggested,
      unsureCount: sum.art.unsure,
      untaggedCount: sum.art.untagged,
      annexCount: sum.annex.total,
    };
  }

  /** 从读进内存的队列里取一页：筛分段 / 类型 / 主题 → 收拢组图 → 按游标定位 → 切一页（多取一行看还有没有下一页） */
  private pageFromQueue(f: Filter, mode: Mode, collapse: boolean, c: Record<string, unknown> | null, limit: number): PageSlice {
    const m = ORDER[mode];
    const queue = this.queue(f.annex ? 'annex' : 'art');
    const sorted = (queue.sorted[mode] ??= [...queue.rows].sort(m.cmp));
    const inBucket = BUCKET_KEEP[f.bucket ?? 'all'];
    const kindOnly = f.annex ? f.kind : f.artKind;
    let pool = sorted.filter((r) => (f.annex || inBucket(r)) && (kindOnly === null || r.k === kindOnly));
    if (f.theme) pool = this.ofTheme(pool, f.theme);

    let members: Map<number, number[]> | null = null;
    let displayTotal: number | undefined;
    if (collapse) {
      const collapsed = collapseGroups(pool);
      pool = collapsed.cells;
      members = collapsed.members;
      displayTotal = pool.length;
    }
    const from = c ? firstAfter(pool, m.cmp, cursorKeys(mode, c)) : 0;
    const rows = pool.slice(from, from + limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      rows: rows.map((r) => (members && r.g !== null ? { ...r, group: this.groupOf(r.g, members.get(r.g)!) } : r)),
      hasMore,
      displayTotal,
    };
  }

  /**
   * 筛主题：主题是存的 theme 上叠加漫画、不像插画、敏感（THEME_EXPR），其中「敏感」跟着分级走。
   * 队列缓存在改分级时不一定清，所以主题不进缓存，对筛过分段的这批图现查（2.5 万张约 20 ms）
   */
  private ofTheme(pool: QueueRow[], theme: UnrecognizedTheme): QueueRow[] {
    const hit = new Set(
      this.ctx
        .stmt(`SELECT i.id FROM images i WHERE i.id IN (SELECT value FROM json_each(@ids)) AND ${THEME_EXPR} = @theme`)
        .pluck()
        .all({ ids: JSON.stringify(pool.map((r) => r.id)), theme }) as number[],
    );
    return pool.filter((r) => hit.has(r.id));
  }

  /**
   * 这一页上的一组：标题、整组计入统计的张数、筛选范围里的成员是不是都收藏了。现查，不进队列缓存（收藏不清那份缓存）。
   * 整组只剩一张（或者组已经不在了）就当单张
   */
  private groupOf(id: number, members: number[]): PageGroup | undefined {
    const memberIds = [...members].sort((x, y) => x - y);
    const g = this.ctx
      .stmt(
        `SELECT g.title, g.kind, (SELECT COUNT(*) FROM v_counted_images v WHERE v.collection_id = g.id) AS total,
           (SELECT MIN(mi.favorite) FROM images mi WHERE mi.id IN (SELECT value FROM json_each(@members))) AS favorite
         FROM collections g WHERE g.id = @id`,
      )
      .get({ id, members: JSON.stringify(memberIds) }) as { title: string | null; kind: CollectionKind; total: number; favorite: number } | undefined;
    if (!g || g.total <= 1) return undefined;
    return { id, title: g.title, kind: g.kind, count: memberIds.length, total: g.total, allFavorite: g.favorite === 1, memberIds };
  }

  /** SQL 的写法（队列读进内存之前的）：每一页都把整个队列查一遍。只给测试用，拿来和 pageFromQueue 逐页对比 */
  private pageFromSql(f: Filter, mode: Mode, collapse: boolean, c: Record<string, unknown> | null, limit: number): PageSlice {
    const { annex, bucket, theme, kind, artKind } = f;
    const m = ORDER[mode];
    const where = annex
      ? kind
        ? 'i.content_kind = @kind'
        : '1'
      : `${BUCKET_WHERE[bucket ?? 'all']}${theme ? ' AND th = @theme' : ''}`;
    const flatSql = annex
      ? `SELECT * FROM (${ROW_ANNEX} AND ${where}) WHERE ${m.after} ORDER BY ${m.order} LIMIT @take`
      : `SELECT * FROM (${ROW_ART}${artKind ? ' AND i.content_kind = @artKind' : ''}) WHERE ${where} AND (${m.after}) ORDER BY ${m.order} LIMIT @take`;
    const base = annex ? `${ROW_ANNEX} AND ${where}` : `SELECT * FROM (${ROW_ART}${artKind ? ' AND i.content_kind = @artKind' : ''}) WHERE ${where}`;
    const partition = 'COALESCE(-g.id, pool.id)';
    const rankedOrder = m.order.replace(/\b(c|t|a|id|s|sh)\b/g, 'pool.$1');
    const grouped = `WITH ranked AS (SELECT pool.*, g.id AS group_id, g.title AS group_title, g.kind AS group_kind,
      (SELECT COUNT(*) FROM v_counted_images v WHERE v.collection_id = g.id) AS group_total,
      COUNT(*) OVER (PARTITION BY ${partition}) AS group_count,
      MIN(meta.favorite) OVER (PARTITION BY ${partition}) AS group_favorite,
      json_group_array(pool.id) OVER (PARTITION BY ${partition} ORDER BY pool.id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS member_ids,
      ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${rankedOrder}) AS rn
      FROM (${base}) pool JOIN images meta ON meta.id = pool.id
      LEFT JOIN collections g ON g.id = meta.collection_id AND g.state = 'active' AND g.kind = 'group')`;
    const sql = collapse ? `${grouped} SELECT * FROM ranked WHERE rn = 1 AND (${m.after}) ORDER BY ${m.order} LIMIT @take` : flatSql;
    const displayTotal = collapse ? (this.ctx.stmt(`${grouped} SELECT COUNT(*) n FROM ranked WHERE rn = 1`).get({ kind, artKind, theme }) as { n: number }).n : undefined;
    const rows = this.ctx.stmt(sql).all({
      kind,
      artKind,
      theme,
      c: c?.c ?? null,
      t: c?.t ?? null,
      s: c?.s ?? null,
      a: c?.a ?? null,
      i: c?.i ?? null,
      take: limit + 1,
    }) as (Keys & { group_id?: number; group_title: string | null; group_kind: CollectionKind; group_count: number; group_total: number; group_favorite: number; member_ids: string })[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      rows: rows.map((r) => ({
        id: r.id,
        a: r.a,
        sh: r.sh,
        c: r.c,
        t: r.t,
        s: r.s,
        ...(r.group_id && r.group_total > 1
          ? {
              group: {
                id: r.group_id,
                title: r.group_title,
                kind: r.group_kind,
                count: r.group_count,
                total: r.group_total,
                allFavorite: r.group_favorite === 1,
                memberIds: JSON.parse(r.member_ids) as number[],
              },
            }
          : {}),
      })),
      hasMore,
      displayTotal,
    };
  }
}
