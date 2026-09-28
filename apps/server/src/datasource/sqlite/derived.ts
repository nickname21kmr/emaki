import { performance } from 'node:perf_hooks';
/**
 * 派生缓存（与 mock 的 idx 同一思路）：每个角色 / 作品的张数、封面等聚合结果缓存在内存，数据变化时失效重建。
 * 口径见 TASKS.md「全局约定 → 数据口径」：张数、+N、最近在收只数插画（v_illust_images，D3），其余类型记在 otherCount。
 */
import { searchKey, type CharacterSource, type FocusPoint, type Rating } from '@emaki/shared';
import { hashString, hslToHex } from '../../util/color.ts';
import { FOCUS_TAGS, inferCoverFocus } from '../../services/covers/focus.ts';
import { COVER_TAG_WEIGHTS, coverQuality, isUnfitCover } from '../../services/covers/quality.ts';
import type { SqliteContext } from './context.ts';
import { DAY, iso, RECENT_DAYS } from './sql.ts';

export interface CharacterRec {
  id: number;
  name: string;
  danbooruTag: string | null;
  source: CharacterSource;
  aliases: string[];
  workIds: number[];
  coverImageId: number | null;
  coverFocus: FocusPoint | null;
  pinned: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  imageCount: number;
  /** 关联的非插画张数 */
  otherCount: number;
  newCount: number;
  lastAddedAt: string | null;
  effectiveCoverId: number | null;
  /** effectiveCoverId 那张图的分级；没有封面时 'general'（前端据此模糊敏感封面） */
  coverRating: Rating;
  /** 封面是用户手动设的 */
  coverManual: boolean;
  /** 封面图主色 */
  coverColor: string | null;
  /** 最近 30 天入库的张数 */
  recentCount: number;
  /** searchKey(名字、标签、全部别名（含隐藏的）、所属作品名和别名) */
  keys: string[];
}

export interface WorkRec {
  id: number;
  name: string;
  danbooruTag: string | null;
  aliases: string[];
  color: string;
  imageCount: number;
  otherCount: number;
  recentImageCount: number;
  characterCount: number;
  coverImageId: number | null;
  coverRating: Rating;
  coverColor: string | null;
  /** 扇形叠放用：0–3 张，[0] = coverImageId */
  covers: { imageId: number; rating: Rating; color: string | null; focus: FocusPoint | null }[];
  keys: string[];
}

export interface DerivedData {
  characters: Map<number, CharacterRec>;
  works: Map<number, WorkRec>;
  builtAt: number;
}

/** recent 窗口随时间移动，缓存最多用 5 分钟 */
const MAX_AGE = 5 * 60_000;

export class Derived {
  private data: DerivedData | null = null;
  /** 软失效（后台任务写库）之后、重建之前为 true；见 SoftCache */
  private softStale = false;
  private builtPerf = 0;

  /** softMs：后台任务写库后，旧数据最多再用多久（整份重建要几百毫秒，识别期间每 5 秒来一次失效） */
  constructor(
    private readonly ctx: SqliteContext,
    private readonly softMs = 0,
  ) {}

  invalidate(soft = false): void {
    if (soft && this.data) this.softStale = true;
    else this.data = null;
  }

  get(): DerivedData {
    const now = this.ctx.clock();
    const expired = this.softStale && performance.now() - this.builtPerf >= this.softMs;
    if (!this.data || now - this.data.builtAt > MAX_AGE || expired) {
      this.data = this.build(now);
      this.softStale = false;
      this.builtPerf = performance.now();
    }
    return this.data;
  }

  private build(now: number): DerivedData {
    const db = this.ctx.db;
    const cutoff = iso(now - RECENT_DAYS * DAY);

    // A 基础行
    const charRows = db
      .prepare(
        'SELECT id, name, danbooru_tag, source, cover_image_id, cover_manual, cover_focus_x, cover_focus_y, pinned, last_seen_at, created_at FROM characters ORDER BY id',
      )
      .all() as {
      id: number;
      name: string;
      danbooru_tag: string | null;
      source: CharacterSource;
      cover_image_id: number | null;
      cover_manual: number;
      cover_focus_x: number | null;
      cover_focus_y: number | null;
      pinned: number;
      last_seen_at: string | null;
      created_at: string;
    }[];
    const cwRows = db
      .prepare('SELECT character_id, work_id FROM character_works ORDER BY character_id, position, work_id')
      .all() as { character_id: number; work_id: number }[];
    const aliasRows = db
      .prepare('SELECT owner_type, owner_id, alias, visible FROM aliases ORDER BY position, alias')
      .all() as { owner_type: 'character' | 'work'; owner_id: number; alias: string; visible: number }[];
    const workRows = db.prepare('SELECT id, name, danbooru_tag, color FROM works ORDER BY id').all() as {
      id: number;
      name: string;
      danbooru_tag: string | null;
      color: string | null;
    }[];

    // B 角色统计
    const charStats = new Map(
      (
        db
          .prepare(
            `SELECT ic.character_id AS id, COUNT(*) AS image_count, MAX(i.added_at) AS last_added_at,
                    SUM(i.added_at >= @cutoff) AS recent_count,
                    SUM(i.added_at > COALESCE(c.last_seen_at, @cutoff)) AS new_count
             FROM image_characters ic
             JOIN v_illust_images i ON i.id = ic.image_id
             JOIN characters c ON c.id = ic.character_id
             GROUP BY ic.character_id`,
          )
          .all({ cutoff }) as {
          id: number;
          image_count: number;
          last_added_at: string | null;
          new_count: number | null;
          recent_count: number | null;
        }[]
      ).map((r) => [r.id, r]),
    );

    // B' 非插画张数（漫画、截图等）
    const charOther = new Map(
      (
        db
          .prepare(
            `SELECT ic.character_id AS id, COUNT(*) AS n FROM image_characters ic
             JOIN v_counted_images i ON i.id = ic.image_id WHERE i.content_kind <> 'illustration' GROUP BY ic.character_id`,
          )
          .all() as { id: number; n: number }[]
      ).map((r) => [r.id, r.n]),
    );
    const workOther = new Map(
      (
        db
          .prepare(
            `SELECT w.work_id AS id, COUNT(*) AS n FROM v_image_works w
             JOIN v_counted_images i ON i.id = w.image_id WHERE i.content_kind <> 'illustration' GROUP BY w.work_id`,
          )
          .all() as { id: number; n: number }[]
      ).map((r) => [r.id, r.n]),
    );

    // C 自动封面（T25.5，CB-2）：封面要好看——每个角色按分级档位先取 40 张候选，
    // 再按「画面质量分」排（见 coverQuality），最后在角色之间去重。只用插画；没有插画才用漫画页兜底（tier +3），截图等永远不用（T27）
    // 排序在 JS 里做（T22：原来是整张表开窗 ROW_NUMBER，真实库 3 万多行要 190 ms；取行 + 排序约 60 ms）。
    // 顺序：档位（分级、漫画垫底）→ 收藏在前 → 同框人少的在前 → 识别分数高的在前 → 短边长的在前 → 新的在前；每个角色取前 40
    const crowd = new Map(
      (db.prepare('SELECT image_id, COUNT(*) AS n FROM image_characters GROUP BY image_id').all() as { image_id: number; n: number }[]).map(
        (r) => [r.image_id, r.n],
      ),
    );
    const byChar = new Map<number, CoverCandidate[]>();
    for (const r of db
      .prepare(
        `SELECT ${COVER_CANDIDATE_COLS.replace('COALESCE(cr.n, 1) - 1', '0')}
         FROM image_characters ic JOIN v_counted_images i ON i.id = ic.image_id
         WHERE i.content_kind IN ('illustration','comic')`,
      )
      .all() as CoverCandidate[]) {
      r.others = (crowd.get(r.iid) ?? 1) - 1;
      const list = byChar.get(r.cid);
      if (list) list.push(r);
      else byChar.set(r.cid, [r]);
    }
    const candRows: CoverCandidate[] = [];
    for (const list of byChar.values()) {
      list.sort(
        (a, b) => a.tier - b.tier || b.fav - a.fav || a.others - b.others || b.cs - a.cs || Math.min(b.w, b.h) - Math.min(a.w, a.h) || b.iid - a.iid,
      );
      for (let k = 0; k < list.length && k < 40; k++) candRows.push(list[k]!);
    }
    const candTags = loadCoverTags(db, candRows.map((r) => r.iid));
    const cands = new Map<number, ScoredCoverCandidate[]>();
    for (const item of scoreCoverCandidates(candRows, candTags)) {
      const list = cands.get(item.cid);
      if (list) list.push(item);
      else cands.set(item.cid, [item]);
    }
    const manualCovers = new Set(
      charRows.filter((c) => c.cover_manual === 1 && c.cover_image_id !== null).map((c) => c.cover_image_id!),
    );
    const autoCover = new Map<number, number>();
    /** 自动封面的焦点：按构图标签推断（T28） */
    const autoFocus = new Map<number, FocusPoint | null>();
    const used = new Set<number>(manualCovers);
    // 候选少的角色先挑（它们没得选），同样多按 id
    for (const [cid, list] of [...cands].sort((a, b) => a[1].length - b[1].length || a[0] - b[0])) {
      const best = list[0]!;
      // 去重只在「差不多好看」的范围里换；实在没有就允许重复（例如只有一张合影）
      const pick = list.find((x) => x.tier === best.tier && x.q >= best.q - 30 && !used.has(x.iid)) ?? best;
      autoCover.set(cid, pick.iid);
      autoFocus.set(cid, inferCoverFocus(candTags.get(pick.iid) ?? []));
      used.add(pick.iid);
    }

    // D 显式封面仍然可见的角色
    const coverVisible = new Set(
      db.prepare('SELECT c.id FROM characters c JOIN v_counted_images i ON i.id = c.cover_image_id').pluck().all() as number[],
    );

    // E 作品统计
    const workStats = new Map(
      (
        db
          .prepare(
            `SELECT w.work_id AS id, COUNT(*) AS image_count, SUM(i.added_at >= ?) AS recent_count
             FROM v_image_works w JOIN v_illust_images i ON i.id = w.image_id
             GROUP BY w.work_id`,
          )
          .all(cutoff) as { id: number; image_count: number; recent_count: number | null }[]
      ).map((r) => [r.id, r]),
    );

    // F 作品的角色数：只数有插画的角色，和角色列表的默认口径一致（只在漫画等里出现的另算，见 otherOnlyCount）
    const workCharCount = new Map<number, number>();
    for (const r of cwRows) {
      if ((charStats.get(r.character_id)?.image_count ?? 0) > 0) workCharCount.set(r.work_id, (workCharCount.get(r.work_id) ?? 0) + 1);
    }

    // 组装
    const aliasMap = new Map<string, typeof aliasRows>();
    for (const a of aliasRows) {
      const key = `${a.owner_type}:${a.owner_id}`;
      const list = aliasMap.get(key);
      if (list) list.push(a);
      else aliasMap.set(key, [a]);
    }
    const aliasList = (type: 'character' | 'work', id: number) => aliasMap.get(`${type}:${id}`) ?? [];

    const works = new Map<number, WorkRec>();
    for (const w of workRows) {
      const all = aliasList('work', w.id);
      const st = workStats.get(w.id);
      works.set(w.id, {
        id: w.id,
        name: w.name,
        danbooruTag: w.danbooru_tag,
        aliases: all.filter((a) => a.visible).map((a) => a.alias),
        color: w.color ?? hslToHex(hashString(w.name) % 360, 62, 58),
        imageCount: st?.image_count ?? 0,
        otherCount: workOther.get(w.id) ?? 0,
        recentImageCount: st?.recent_count ?? 0,
        characterCount: workCharCount.get(w.id) ?? 0,
        coverImageId: null,
        coverRating: 'general',
        coverColor: null,
        covers: [],
        keys: [w.name, w.danbooru_tag, ...all.map((a) => a.alias)].filter((x): x is string => !!x).map(searchKey),
      });
    }

    const workIdsOf = new Map<number, number[]>();
    for (const r of cwRows) {
      const list = workIdsOf.get(r.character_id);
      if (list) list.push(r.work_id);
      else workIdsOf.set(r.character_id, [r.work_id]);
    }

    const characters = new Map<number, CharacterRec>();
    for (const c of charRows) {
      const all = aliasList('character', c.id);
      const st = charStats.get(c.id);
      const workIds = workIdsOf.get(c.id) ?? [];
      const workKeys = workIds.flatMap((wid) => works.get(wid)?.keys ?? []);
      characters.set(c.id, {
        id: c.id,
        name: c.name,
        danbooruTag: c.danbooru_tag,
        source: c.source,
        aliases: all.filter((a) => a.visible).map((a) => a.alias),
        workIds,
        coverImageId: c.cover_image_id,
        // 焦点只对手动封面有意义；自动封面由前端兜底
        coverFocus:
          c.cover_manual === 1
            ? c.cover_focus_x !== null && c.cover_focus_y !== null
              ? { x: c.cover_focus_x, y: c.cover_focus_y }
              : null
            : (autoFocus.get(c.id) ?? null),
        pinned: !!c.pinned,
        lastSeenAt: c.last_seen_at,
        createdAt: c.created_at,
        imageCount: st?.image_count ?? 0,
        otherCount: charOther.get(c.id) ?? 0,
        newCount: st?.new_count ?? 0,
        lastAddedAt: st?.last_added_at ?? null,
        effectiveCoverId:
          c.cover_manual === 1 && c.cover_image_id !== null && coverVisible.has(c.id) ? c.cover_image_id : (autoCover.get(c.id) ?? null),
        coverRating: 'general',
        coverManual: c.cover_manual === 1,
        coverColor: null,
        recentCount: st?.recent_count ?? 0,
        keys: [
          ...[c.name, c.danbooru_tag, ...all.map((a) => a.alias)].filter((x): x is string => !!x).map(searchKey),
          ...workKeys,
        ],
      });
    }

    // 封面分级：一次查出
    const coverIds = [
      ...new Set([...characters.values()].map((c) => c.effectiveCoverId).filter((x): x is number => x !== null)),
    ];
    const coverInfo = new Map<number, { rating: Rating; color: string | null }>();
    if (coverIds.length) {
      for (const r of db
        .prepare('SELECT id, rating, dominant_color AS color FROM images WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(coverIds)) as { id: number; rating: Rating; color: string | null }[])
        coverInfo.set(r.id, { rating: r.rating, color: r.color });
      for (const c of characters.values()) {
        if (c.effectiveCoverId === null) continue;
        const info = coverInfo.get(c.effectiveCoverId);
        c.coverRating = info?.rating ?? 'general';
        c.coverColor = info?.color ?? null;
      }
    }

    // 作品封面：从这部作品的角色封面里挑——分级安全优先，其次张数多（并列 id 小）；
    // 张数多的作品先挑，挑过的图别的作品尽量不再用（Love Live! 和 Sunshine!! 共用角色）
    const tierOf = (r: Rating) => (r === 'questionable' ? 1 : r === 'explicit' ? 2 : 0);
    const charsOfWork = new Map<number, CharacterRec[]>();
    for (const c of characters.values()) {
      if (c.effectiveCoverId === null) continue;
      for (const wid of c.workIds) {
        const list = charsOfWork.get(wid);
        if (list) list.push(c);
        else charsOfWork.set(wid, [c]);
      }
    }
    // 每部作品最多 3 张互不重复的封面（MG-1）：张数多的作品先挑，全局 used 尽量不跨作品重复；
    // 候选排序：主作品是它的角色优先 → 分级安全 → 张数多 → id；同名分身（去掉括号后缀相同）只取一个
    const baseName = (c: CharacterRec) => (c.danbooruTag ?? c.name).replace(/_([^)]*)$/, '');
    const usedWork = new Set<number>();
    const ref = (iid: number, rating: Rating, color: string | null, focus: FocusPoint | null) => ({ imageId: iid, rating, color, focus });
    for (const w of [...works.values()].sort((a, b) => b.imageCount - a.imageCount || a.id - b.id)) {
      const list = (charsOfWork.get(w.id) ?? []).sort(
        (a, b) =>
          Number(b.workIds[0] === w.id) - Number(a.workIds[0] === w.id) ||
          tierOf(a.coverRating) - tierOf(b.coverRating) ||
          b.imageCount - a.imageCount ||
          a.id - b.id,
      );
      const covers: WorkRec['covers'] = [];
      const taken = new Set<number>();
      const names = new Set<string>();
      const take = (c: CharacterRec, allowUsed: boolean) => {
        const iid = c.effectiveCoverId!;
        if (covers.length >= 3 || taken.has(iid) || names.has(baseName(c)) || (!allowUsed && usedWork.has(iid))) return;
        covers.push(ref(iid, c.coverRating, c.coverColor, c.coverFocus));
        taken.add(iid);
        names.add(baseName(c));
      };
      for (const c of list) take(c, false);
      // 不够 3 张：用这些角色的其他好图补位（同样的质量排序，只取安全档）
      if (covers.length < 3) {
        for (const c of list) {
          for (const x of cands.get(c.id) ?? []) {
            if (covers.length >= 3) break;
            if (x.tier > 0 || taken.has(x.iid) || usedWork.has(x.iid)) continue;
            covers.push(ref(x.iid, 'general', null, inferCoverFocus(candTags.get(x.iid) ?? [])));
            taken.add(x.iid);
          }
        }
      }
      // 还不够才允许和别的作品重复
      if (covers.length < 3) for (const c of list) take(c, true);
      if (!covers.length) continue;
      w.coverImageId = covers[0]!.imageId;
      w.coverRating = covers[0]!.rating;
      w.coverColor = covers[0]!.color;
      w.covers = covers;
      for (const c of covers) usedWork.add(c.imageId);
    }

    // 补位图的分级和主色（上面先记成 general / null）
    const fillIds = [...works.values()].flatMap((w) => w.covers.filter((c) => c.color === null).map((c) => c.imageId));
    if (fillIds.length) {
      const info = new Map(
        (
          db
            .prepare('SELECT id, rating, dominant_color AS color FROM images WHERE id IN (SELECT value FROM json_each(?))')
            .all(JSON.stringify([...new Set(fillIds)])) as { id: number; rating: Rating; color: string | null }[]
        ).map((r) => [r.id, r]),
      );
      for (const w of works.values())
        for (const c of w.covers) {
          const r = info.get(c.imageId);
          if (r) Object.assign(c, { rating: r.rating, color: r.color });
        }
    }

    return { characters, works, builtAt: now };
  }
}

export interface CoverCandidate {
  cid: number;
  iid: number;
  tier: number;
  w: number;
  h: number;
  fileName: string;
  fav: number;
  cs: number;
  others: number;
}

export type ScoredCoverCandidate = CoverCandidate & { q: number };

/** 候选封面的列（C 自动封面和「换封面」候选共用）；FROM image_characters ic JOIN v_counted_images i，crowd 是同图角色数 */
export const COVER_CANDIDATE_COLS = `ic.character_id AS cid, i.id AS iid, i.width AS w, i.height AS h, i.file_name AS fileName,
  i.favorite AS fav, COALESCE(ic.score, 0.9) AS cs, COALESCE(cr.n, 1) - 1 AS others,
  CASE i.rating WHEN 'questionable' THEN 1 WHEN 'explicit' THEN 2 ELSE 0 END + (i.content_kind = 'comic') * 3 AS tier`;

/** 一批图里和封面评分、焦点有关的标签 */
export function loadCoverTags(db: SqliteContext['db'], iids: number[]): Map<number, [string, number][]> {
  const candTags = new Map<number, [string, number][]>();
  if (!iids.length) return candTags;
  // 按名字 JOIN tags、再限定候选图（T22 实测：先换成 tag_id 反而慢一倍，这些标签里有 solo、1girl 这种几乎每张都有的）
  for (const r of db
    .prepare(
      // 固定成「先标签、再按 tag_id 扫覆盖索引、候选图只做成员检查」：统计信息一变，SQLite 会改成逐张图去查，慢二十倍（T22 复测）
      `SELECT it.image_id AS iid, t.name, it.score FROM tags t CROSS JOIN image_tags it INDEXED BY idx_image_tags_tag_score ON it.tag_id = t.id
       WHERE t.name IN (SELECT value FROM json_each(@names))
         AND it.image_id IN (SELECT value FROM json_each(@ids))`,
    )
    .all({ names: JSON.stringify([...Object.keys(COVER_TAG_WEIGHTS), ...FOCUS_TAGS]), ids: JSON.stringify([...new Set(iids)]) }) as {
    iid: number;
    name: string;
    score: number;
  }[]) {
    const list = candTags.get(r.iid);
    if (list) list.push([r.name, r.score]);
    else candTags.set(r.iid, [[r.name, r.score]]);
  }
  return candTags;
}

/**
 * 去掉不能当封面的图，算画面质量分，按 tier（漫画页 +3、分级档位）→ 质量分 → id 倒序排好。
 * 截图、聊天记录、以文字为主的图永远不当封面：宁可显示名字首字（用户要求）
 */
export function scoreCoverCandidates(rows: CoverCandidate[], tags: Map<number, [string, number][]>): ScoredCoverCandidate[] {
  const out: ScoredCoverCandidate[] = [];
  for (const r of rows) {
    const t = tags.get(r.iid) ?? [];
    if (isUnfitCover(r.fileName, t)) continue;
    out.push({ ...r, q: coverQuality(r, t) });
  }
  return out.sort((a, b) => a.tier - b.tier || b.q - a.q || b.iid - a.iid);
}
