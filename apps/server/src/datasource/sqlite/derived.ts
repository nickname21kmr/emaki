import { performance } from 'node:perf_hooks';
/**
 * 派生缓存：每个角色 / 作品的张数、封面等聚合结果缓存在内存，数据变化时失效重建。
 * 口径见 TASKS.md「全局约定 → 数据口径」：张数、+N、最近在收只数插画（v_illust_images，D3），其余类型记在 otherCount。
 *
 * 整份重建在真实库上要 0.6–1 秒，所以不是每次写入都整份失效（propagation/cacheScope.ts 定范围）：
 * 收藏、分级只在改到现在的封面图时失效；归类、原创只重算涉及的角色和作品的张数（封面等下一次整份重建再重挑）；
 * 进角色页「看过了」只重算那个角色的「+N」。其余变化照旧整份失效。
 */
import { searchKey, type CharacterSource, type FocusPoint, type Rating } from '@emaki/shared';
import { hashString, hslToHex } from '../../util/color.ts';
import { FOCUS_TAGS, inferCoverFocus } from '../../services/covers/focus.ts';
import { COVER_TAG_WEIGHTS, coverQuality, isUnfitCover } from '../../services/covers/quality.ts';
import type { CacheScope } from '../../propagation/cacheScope.ts';
import type { SqliteContext } from './context.ts';
import { localDay } from './softCache.ts';
import { DAY, iso, RECENT_DAYS } from './sql.ts';
import { ART_KINDS_SQL, ILLUSTRATION } from '../../readmodel/terms.ts';

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
  /** 名字锁定了：用户手动新建或改过名（识别器自动建的是 false） */
  nameLocked: boolean;
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
  /** 与作品名区分，让角色原名和别名的命中优先。 */
  nameKeys: string[];
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

/**
 * recent 窗口（最近 30 天）随时间移动，但按天算：缓存最多用 1 小时，本地日期变了也重建。
 * 也是定向重算的兜底：万一有漏，下一次整份重建会纠正
 */
const MAX_AGE = 60 * 60_000;
/** 一次定向重算最多认这么多张图，再多就整份重建 */
const RECOUNT_MAX_IMAGES = 500;
/** 受影响的作品不超过这么多时一部一部重数（最大的一部十几毫秒，多数不到 1 毫秒）；再多就把全部作品一遍数完（约 0.14 秒） */
const RECOUNT_WORKS_EACH = 8;

/** 整份重建时顺手记下的，定向重算要用 */
interface Tracking {
  /** 现在的封面图：角色的 effectiveCoverId，加上作品 covers 里的全部 */
  coverIds: Set<number>;
  /** 图 → 它关联的角色。变化只带图的 id，「改之前属于哪些角色」要靠它 */
  charsOfImage: Map<number, number[]>;
  /** 编目的规模（catalogShape） */
  catalog: string;
}

/**
 * 编目的规模：角色、作品的行数和最大 id，角色的作品、别名的行数。采纳建议会按标签建档（新角色、新作品、别名），
 * 标原创会建「原创」作品，撤销时又删掉，这些都不单独声明变化；规模对不上就是名字、别名、作品关系要重读，整份重建。
 * 每次提交之后都对一遍（不到 0.1 毫秒），所以同一个 id 删了又建也看得出来
 */
function catalogShape(db: SqliteContext['db']): string {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM characters) || ':' || (SELECT COALESCE(MAX(id), 0) FROM characters)
         || ':' || (SELECT COUNT(*) FROM works) || ':' || (SELECT COALESCE(MAX(id), 0) FROM works)
         || ':' || (SELECT COUNT(*) FROM character_works) || ':' || (SELECT COUNT(*) FROM aliases)`,
    )
    .pluck()
    .get() as string;
}

/** 角色的插画张数、最近入库、30 天内张数、「+N」；scoped = 只算 @ids 里的角色（走 character_id 的索引） */
const charStatsSql = (scoped: boolean) => `SELECT ic.character_id AS id, COUNT(*) AS image_count, MAX(i.added_at) AS last_added_at,
        SUM(i.added_at >= @cutoff) AS recent_count,
        SUM(i.added_at > COALESCE(c.last_seen_at, @cutoff)) AS new_count
 FROM image_characters ic
 JOIN v_illust_images i ON i.id = ic.image_id
 JOIN characters c ON c.id = ic.character_id
 ${scoped ? 'WHERE ic.character_id IN (SELECT value FROM json_each(@ids))' : ''}
 GROUP BY ic.character_id`;
/** 角色的非插画张数（漫画、截图等） */
const charOtherSql = (scoped: boolean) => `SELECT ic.character_id AS id, COUNT(*) AS n FROM image_characters ic
 JOIN v_counted_images i ON i.id = ic.image_id
 WHERE NOT ${ILLUSTRATION}${scoped ? ' AND ic.character_id IN (SELECT value FROM json_each(@ids))' : ''} GROUP BY ic.character_id`;
/** 作品的三个数，一遍数完 */
const WORK_COUNTS = `COALESCE(SUM(${ILLUSTRATION}), 0) AS image_count, COALESCE(SUM(${ILLUSTRATION} AND i.added_at >= @cutoff), 0) AS recent_count,
        COALESCE(SUM(NOT ${ILLUSTRATION}), 0) AS other_count`;
/** 全部作品：v_image_works（UNION 视图）只扫一遍。以前插画和非插画各扫一遍，合计约 210 ms，现在约 140 ms */
const WORK_STATS_SQL = `SELECT w.work_id AS id, ${WORK_COUNTS}
 FROM v_image_works w JOIN v_counted_images i ON i.id = w.image_id GROUP BY w.work_id`;
/** 一部作品：先按作品的索引找出它的图 */
const WORK_STATS_ONE_SQL = `SELECT ${WORK_COUNTS} FROM v_counted_images i
 WHERE i.id IN (SELECT image_id FROM v_image_works WHERE work_id = @work)`;

interface CharStats {
  id: number;
  image_count: number;
  last_added_at: string | null;
  new_count: number | null;
  recent_count: number | null;
}
interface WorkStats {
  image_count: number;
  recent_count: number;
  other_count: number;
}

export class Derived {
  private data: DerivedData | null = null;
  private track: Tracking | null = null;
  /** 软失效（后台任务写库）之后、重建之前为 true；见 SoftCache */
  private softStale = false;
  private builtPerf = 0;
  /** 建的那天（本地日期） */
  private builtDay = 0;
  /** 等着定向重算的（下一次 get 时做）：角色关联变了的图、原创标记变了的图、刚看过的角色 */
  private readonly pending = { links: new Set<number>(), original: new Set<number>(), seen: new Set<number>() };

  /**
   * softMs：后台任务写库后，旧数据最多再用多久（整份重建要几百毫秒，识别期间每几秒来一次失效）。
   * 给函数是因为它看当时有没有后台任务在跑：跑着的时候多用一会儿，都结束了就按短的算（SqliteDataSource）
   */
  constructor(
    private readonly ctx: SqliteContext,
    private readonly softMs: () => number = () => 0,
  ) {}

  invalidate(soft = false): void {
    if (soft && this.data) this.softStale = true;
    else this.drop();
  }

  /** 后台任务结束：软失效过的直接丢掉，任务结束那次推送拿到最终的数（后面还排着任务时软窗口是 30 秒，不结清会一直旧） */
  settleSoft(): void {
    if (this.softStale) this.drop();
  }

  private drop(): void {
    this.data = null;
    this.track = null;
    this.pending.links.clear();
    this.pending.original.clear();
    this.pending.seen.clear();
  }

  /**
   * 一次提交只改到一部分（propagation/cacheScope.ts 的 derived）：
   * - covers 收藏、分级变了的图：张数不受影响。自动封面优先挑收藏的、按分级分档，封面的分级也存在这里（敏感封面要打码），
   *   所以其中有现在的封面图时整份失效；不是封面的不动，封面等下一次整份重建再重挑。
   * - links / original 角色关联、原创标记变了的图：只重算涉及的角色和作品的张数，下一次 get 时做（封面不重挑）。
   *   做不了就整份失效：图太多、改到现在的封面图、这份缓存已经被后台任务写旧了（反查表不准）。
   * - seen 刚看过的角色：只重算它们的「+N」和上次看过的时间。
   * 后台任务写的（soft）不做定向重算，照旧软失效。
   */
  narrow(scope: CacheScope['derived'], soft = false): void {
    if (scope.all) return this.invalidate(soft);
    if (!this.data || !this.track) return;
    const touched = scope.links.length || scope.original.length || scope.seen.length;
    // 每次提交之后都对一遍编目的规模：没人声明却变了（按标签建档、撤销建档）就整份失效。
    // 已经软失效的不用再判：后台任务在建角色，等软窗口到了本来就要整份重建
    if (!this.softStale && catalogShape(this.ctx.db) !== this.track.catalog) return this.invalidate(soft);
    const { coverIds } = this.track;
    const cover = (ids: readonly number[]) => ids.some((id) => coverIds.has(id));
    if (cover(scope.covers)) return this.invalidate(soft);
    if (!touched) return;
    if (soft) return this.invalidate(true);
    const p = this.pending;
    if (scope.links.length || scope.original.length) {
      if (this.softStale || cover(scope.links) || cover(scope.original)) return this.drop();
      for (const id of scope.links) p.links.add(id);
      for (const id of scope.original) p.original.add(id);
      if (new Set([...p.links, ...p.original]).size > RECOUNT_MAX_IMAGES) return this.drop();
    }
    for (const id of scope.seen) p.seen.add(id);
  }

  get(): DerivedData {
    const now = this.ctx.clock();
    const expired = this.softStale && performance.now() - this.builtPerf >= this.softMs();
    if (!this.data || !this.track || now - this.data.builtAt > MAX_AGE || localDay(now) !== this.builtDay || expired) return this.rebuild(now);
    const p = this.pending;
    if ((p.links.size || p.original.size || p.seen.size) && !this.applyPending(this.data, this.track)) return this.rebuild(now);
    return this.data;
  }

  private rebuild(now: number): DerivedData {
    this.drop();
    const built = this.build(now);
    this.data = built.data;
    this.track = built.track;
    this.softStale = false;
    this.builtPerf = performance.now();
    this.builtDay = localDay(now);
    return built.data;
  }

  /**
   * 定向重算：等着的那些图涉及的角色、作品，按和整份重建同一条语句重新数（从事实重算，不是加减）。
   * 返回 false = 这次做不了，要整份重建：编目变了、有角色从没图变成有图或反过来（封面、作品的角色数要跟着变）。
   * 封面不动。重算过的记录换成新对象，data 也换一个外层对象，别处按对象记着旧结果的不会被悄悄改掉
   */
  private applyPending(data: DerivedData, track: Tracking): boolean {
    const db = this.ctx.db;
    if (catalogShape(db) !== track.catalog) return false;
    const { links, original, seen } = this.pending;
    // 和这份缓存建的时候同一个时间口径
    const cutoff = iso(data.builtAt - RECENT_DAYS * DAY);

    // 受影响的角色：改之前关联着这些图的（反查表）∪ 现在关联着的
    const current = new Map<number, number[]>();
    if (links.size) {
      for (const [iid, cid] of db
        .prepare('SELECT image_id, character_id FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) ORDER BY image_id, character_id')
        .raw()
        .all(JSON.stringify([...links])) as [number, number][]) {
        const list = current.get(iid);
        if (list) list.push(cid);
        else current.set(iid, [cid]);
      }
    }
    const linked = new Set<number>();
    for (const iid of links) {
      for (const cid of track.charsOfImage.get(iid) ?? []) linked.add(cid);
      for (const cid of current.get(iid) ?? []) linked.add(cid);
    }
    const charIds = [...new Set([...linked, ...seen])];
    const characters: CharacterRec[] = [];
    if (charIds.length) {
      const ids = JSON.stringify(charIds);
      const stats = new Map((db.prepare(charStatsSql(true)).all({ cutoff, ids }) as CharStats[]).map((r) => [r.id, r]));
      const other = new Map((db.prepare(charOtherSql(true)).all({ ids }) as { id: number; n: number }[]).map((r) => [r.id, r.n]));
      const seenAt = new Map(
        db.prepare('SELECT id, last_seen_at FROM characters WHERE id IN (SELECT value FROM json_each(?))').raw().all(ids) as [number, string | null][],
      );
      for (const id of charIds) {
        const c = data.characters.get(id);
        if (!c || !seenAt.has(id)) return false;
        const st = stats.get(id);
        const next: CharacterRec = {
          ...c,
          lastSeenAt: seenAt.get(id) ?? null,
          imageCount: st?.image_count ?? 0,
          otherCount: other.get(id) ?? 0,
          newCount: st?.new_count ?? 0,
          lastAddedAt: st?.last_added_at ?? null,
          recentCount: st?.recent_count ?? 0,
        };
        const had = (n: number) => n > 0;
        if (had(c.imageCount) !== had(next.imageCount) || had(c.otherCount) !== had(next.otherCount)) return false;
        characters.push(next);
      }
    }

    // 受影响的作品：这些角色的作品；原创标记变了的，再加上「原创」作品和这些图手动指定的作品
    const workIds = new Set<number>();
    for (const cid of linked) for (const wid of data.characters.get(cid)!.workIds) workIds.add(wid);
    if (original.size) {
      for (const w of data.works.values()) if (w.danbooruTag === 'original') workIds.add(w.id);
      for (const wid of db
        .prepare('SELECT DISTINCT work_id FROM image_copyrights WHERE image_id IN (SELECT value FROM json_each(?))')
        .pluck()
        .all(JSON.stringify([...original])) as number[])
        workIds.add(wid);
    }
    const works: WorkRec[] = [];
    const counted = (w: WorkRec, st: WorkStats | undefined): WorkRec => ({
      ...w,
      imageCount: st?.image_count ?? 0,
      otherCount: st?.other_count ?? 0,
      recentImageCount: st?.recent_count ?? 0,
    });
    if (workIds.size > RECOUNT_WORKS_EACH) {
      const all = new Map((db.prepare(WORK_STATS_SQL).all({ cutoff }) as (WorkStats & { id: number })[]).map((r) => [r.id, r]));
      for (const w of data.works.values()) works.push(counted(w, all.get(w.id)));
    } else {
      const one = db.prepare(WORK_STATS_ONE_SQL);
      for (const wid of workIds) {
        const w = data.works.get(wid);
        if (!w) return false;
        works.push(counted(w, one.get({ cutoff, work: wid }) as WorkStats));
      }
    }

    for (const c of characters) data.characters.set(c.id, c);
    for (const w of works) data.works.set(w.id, w);
    for (const iid of links) {
      const list = current.get(iid);
      if (list) track.charsOfImage.set(iid, list);
      else track.charsOfImage.delete(iid);
    }
    links.clear();
    original.clear();
    seen.clear();
    this.data = { ...data };
    return true;
  }

  private build(now: number): { data: DerivedData; track: Tracking } {
    const db = this.ctx.db;
    const cutoff = iso(now - RECENT_DAYS * DAY);
    const catalog = catalogShape(db);

    // A 基础行
    const charRows = db
      .prepare(
        'SELECT id, name, danbooru_tag, source, cover_image_id, cover_manual, cover_focus_x, cover_focus_y, pinned, name_locked, last_seen_at, created_at FROM characters ORDER BY id',
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
      name_locked: number;
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
    const charStats = new Map((db.prepare(charStatsSql(false)).all({ cutoff }) as CharStats[]).map((r) => [r.id, r]));

    // B' 非插画张数（漫画、截图等）
    const charOther = new Map((db.prepare(charOtherSql(false)).all() as { id: number; n: number }[]).map((r) => [r.id, r.n]));

    // C 自动封面（T25.5，CB-2）：封面要好看——每个角色按分级档位先取 40 张候选，
    // 再按「画面质量分」排（见 coverQuality），最后在角色之间去重。只用插画；没有插画才用漫画页兜底（tier +3），截图等永远不用（T27）
    // 排序在 JS 里做（T22：原来是整张表开窗 ROW_NUMBER，真实库 3 万多行要 190 ms；取行 + 排序约 60 ms）。
    // 顺序：档位（分级、漫画垫底）→ 收藏在前 → 同框人少的在前 → 识别分数高的在前 → 短边长的在前 → 新的在前；每个角色取前 40
    // 图 → 角色：同框人数从它来（以前单独按图分组数一遍），定向重算也靠它知道一张图原来属于哪些角色
    const charsOfImage = new Map<number, number[]>();
    for (const [iid, cid] of db.prepare('SELECT image_id, character_id FROM image_characters ORDER BY image_id, character_id').raw().all() as [
      number,
      number,
    ][]) {
      const list = charsOfImage.get(iid);
      if (list) list.push(cid);
      else charsOfImage.set(iid, [cid]);
    }
    const byChar = new Map<number, CoverCandidate[]>();
    for (const r of db
      .prepare(
        `SELECT ${COVER_CANDIDATE_COLS.replace('COALESCE(cr.n, 1) - 1', '0')}
         FROM image_characters ic JOIN v_counted_images i ON i.id = ic.image_id
         WHERE ${ART_KINDS_SQL}`,
      )
      .all() as CoverCandidate[]) {
      r.others = (charsOfImage.get(r.iid)?.length ?? 1) - 1;
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
    const candTags = loadCoverTags(db, [
      ...candRows.map((r) => r.iid),
      ...charRows.filter((c) => c.cover_manual === 1 && c.cover_image_id !== null).map((c) => c.cover_image_id!),
    ]);
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

    // E 作品统计：插画张数、30 天内张数、非插画张数一遍数完
    const workStats = new Map((db.prepare(WORK_STATS_SQL).all({ cutoff }) as (WorkStats & { id: number })[]).map((r) => [r.id, r]));

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
        otherCount: st?.other_count ?? 0,
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
      const nameKeys = [c.name, c.danbooru_tag, ...all.map((a) => a.alias)]
        .filter((x): x is string => !!x).map(searchKey);
      const st = charStats.get(c.id);
      const workIds = workIdsOf.get(c.id) ?? [];
      const workKeys = workIds.flatMap((wid) => works.get(wid)?.keys ?? []);
      const usesManualCover = c.cover_manual === 1 && c.cover_image_id !== null && coverVisible.has(c.id);
      const effectiveCoverId = usesManualCover ? c.cover_image_id : (autoCover.get(c.id) ?? null);
      characters.set(c.id, {
        id: c.id,
        name: c.name,
        danbooruTag: c.danbooru_tag,
        source: c.source,
        aliases: all.filter((a) => a.visible).map((a) => a.alias),
        workIds,
        coverImageId: c.cover_image_id,
        // 明确设置的手动焦点优先；只选了图但没设焦点时，也按构图自动裁切。
        coverFocus:
          usesManualCover
            ? c.cover_focus_x !== null && c.cover_focus_y !== null
              ? { x: c.cover_focus_x, y: c.cover_focus_y }
              : inferCoverFocus(candTags.get(c.cover_image_id!) ?? [])
            : (autoFocus.get(c.id) ?? null),
        pinned: !!c.pinned,
        nameLocked: c.name_locked === 1,
        lastSeenAt: c.last_seen_at,
        createdAt: c.created_at,
        imageCount: st?.image_count ?? 0,
        otherCount: charOther.get(c.id) ?? 0,
        newCount: st?.new_count ?? 0,
        lastAddedAt: st?.last_added_at ?? null,
        effectiveCoverId,
        coverRating: 'general',
        coverManual: c.cover_manual === 1,
        coverColor: null,
        recentCount: st?.recent_count ?? 0,
        nameKeys,
        keys: [...nameKeys, ...workKeys],
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

    const track: Tracking = { coverIds: new Set(coverIds), charsOfImage, catalog };
    for (const w of works.values()) for (const c of w.covers) track.coverIds.add(c.imageId);
    return { data: { characters, works, builtAt: now }, track };
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
  i.favorite AS fav, COALESCE(ic.evidence_score, 0.9) AS cs, COALESCE(cr.n, 1) - 1 AS others,
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
