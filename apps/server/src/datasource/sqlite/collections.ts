import { assertOrganizeReady, organizeCollection } from './organizeCollection.ts';
import { randomUUID } from 'node:crypto';
/**
 * 合集的查询与修改（T38c）。摘要统一由 loadAll 算（口径在 domain/collections/summary.ts），列表、统计、详情各自只读要用的（Scope）。
 * 写操作全部走 ctx.mutate，任何写都把合集转成 origin='manual'（自动判定不会再删它）。
 */
import {
  COLLECTION_KIND_META,
  collectionTitle,
  searchKey,
  type BulkCollectionsBody,
  type CreateCollectionBody,
  type CollectionCountsQuery,
  type CollectionCountsResponse,
  type CollectionKind,
  type CollectionMembership,
  type CollectionPage,
  type CollectionSummary,
  type CollectionTally,
  type ContentKind,
  type GetCollectionResponse,
  type ID,
  type ListCollectionsQuery,
  type MutationResult,
  type Rating,
  type UpdateCollectionBody,
} from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import type { CollectionRow, CollectionService } from '../../domain/collections/CollectionService.ts';
import { autoKind, bookLeaf, decideCollection, dirFeatures, isJudged, type DirPage } from '../../domain/collections/detect.ts';
import { parseBookDir, parseComicDir } from '../../domain/collections/parseName.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { summarize } from '../../domain/collections/summary.ts';
import type { SqliteContext } from './context.ts';
import type { Derived } from './derived.ts';
import { toCharacter, toWork } from './library.ts';
import { DEFAULT_DOMINANT, iso, parseId, toId } from './sql.ts';
import { COUNTED, HAS_CHARACTER, imageWorkRows, LIVE_IMAGES, ROOT_ACTIVE, VISIBLE } from '../../readmodel/terms.ts';
import type { UndoRecorder } from './undo.ts';
import type { CharacterCatalog } from '../../domain/catalog/characterCatalog.ts';
import { resolveSuggestedCharacter } from './suggestions.ts';

/** 合集类型名：和网页同一份（packages/shared 的 COLLECTION_KIND_META） */
const KIND_LABEL = Object.fromEntries(Object.entries(COLLECTION_KIND_META).map(([k, v]) => [k, v.label])) as Record<CollectionKind, string>;
const isKind = (v: unknown): v is CollectionKind => v === 'doujin' || v === 'artbook' || v === 'group';
/** 可变列（撤销时整行记下这些） */
const MUTABLE = [
  'kind', 'kind_source', 'kind_manual', 'title', 'title_manual', 'series_key', 'volume_no', 'series_manual', 'page_order',
  'membership', 'cover_image_id', 'origin', 'state', 'evidence', 'reviewed_at', 'updated_at',
];

interface PageRow {
  id: number;
  collection_id: number;
  page_no: number;
  width: number;
  height: number;
  rating: Rating;
  content_kind: ContentKind;
  dominant_color: string | null;
  tagged_at: string | null;
  added_at: string;
  modified_at: string;
  has_char: number;
}

type Ranked = { id: number; pageCount: number; manual: boolean }[];

interface Loaded {
  /** comic：在按漫画导入的范围里的书，不找角色（不算待整理），页面分级可信（不强制模糊） */
  row: CollectionRow & { root_path: string; comic: boolean };
  summary: CollectionSummary;
  pages: PageRow[];
  /** 完整的出场角色、作品：只有 Scope 里要了才算（没要是 undefined） */
  cast?: Ranked;
  works?: Ranked;
}

/**
 * 读多少（大库上合集有几千本，全读一遍 + 全算角色、作品的命中要两三百毫秒）：
 * - 摘要（列表、统计）只要页、手动关联，和本子的角色命中（本子有没有出场角色决定待整理）；
 * - 按角色筛选要全部合集的出场角色，按作品筛选要作品；详情只读这一本和同系列的几本。
 * 摘要的每个字段和全量算的完全一样（collections.test.ts 逐本比对）。
 */
interface Scope {
  /** 只读这些合集；不给 = 全部 */
  ids?: number[];
  /** 完整的出场角色 */
  cast: boolean;
  /** 作品 */
  works: boolean;
}

const leafOf = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);
const collator = new Intl.Collator('ja', { numeric: true });
/** 列表排序：无题排最后，其余按标题、卷号、id */
export const compareSummaries = (a: CollectionSummary, b: CollectionSummary) =>
  (a.title === null ? 1 : 0) - (b.title === null ? 1 : 0) ||
  collator.compare(a.title ?? '', b.title ?? '') ||
  (a.volumeNo ?? 0) - (b.volumeNo ?? 0) ||
  Number(a.id) - Number(b.id);
/** sort=recent：最近加图的在前（ISO 时间直接比字符串），同时加的再按 compareSummaries */
export const compareRecent = (a: CollectionSummary, b: CollectionSummary) => {
  const x = a.lastAddedAt ?? '';
  const y = b.lastAddedAt ?? '';
  return x < y ? 1 : x > y ? -1 : compareSummaries(a, b);
};

/** 可多选的筛选（kind、membership）：单个值也认；空的等于不筛 */
const many = <T>(v: T | T[] | undefined): T[] | undefined => {
  const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return list.length ? list : undefined;
};
const KINDS: CollectionKind[] = ['doujin', 'artbook', 'group'];
const MEMBERSHIPS: CollectionMembership[] = ['folder', 'selection', 'post'];

/** 合集显示出来：按文件夹成册的看所在图库文件夹可见；手动、同投稿的组图在文件夹停用后，只要还有计入统计的页也显示 */
const COLLECTION_VISIBLE = `((c.membership = 'folder' AND ${ROOT_ACTIVE('r')})
    OR (c.membership <> 'folder' AND ((${ROOT_ACTIVE('r')}) OR EXISTS (SELECT 1 FROM v_counted_images i WHERE i.collection_id = c.id))))`;

/** RV-C-15：一个目录下的直接成员（不含子目录），不用 LIKE */
const DIR_MEMBERS = `SELECT i.id, i.file_name, i.width, i.height, i.modified_at, i.content_kind, i.content_kind_source, i.content_kind_manual, i.animated,
    i.tagged_at
  FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE ${COUNTED()} AND i.root_id = @root
    AND (CASE WHEN @dir = '' THEN instr(i.rel_path, '/') = 0
      ELSE substr(i.rel_path, 1, length(@dir) + 1) = @dir || '/' AND instr(substr(i.rel_path, length(@dir) + 2), '/') = 0 END)`;

export class CollectionQueries {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly service: CollectionService,
    private readonly derived: Derived,
    private readonly catalog: () => CharacterCatalog,
  ) {}

  /** 4.1：active 合集的摘要（读多少见 Scope） */
  private loadAll(scope: Scope): Map<number, Loaded> {
    const db = this.ctx.db;
    const params = scope.ids ? { ids: JSON.stringify(scope.ids) } : {};
    // 合集的范围：两种写法都是字面 SQL，合集 id 走绑定参数
    const inScope = scope.ids ? 'IN (SELECT value FROM json_each(@ids))' : 'IS NOT NULL';
    const rows = db
      .prepare(
        `SELECT c.*, r.path AS root_path FROM collections c JOIN library_roots r ON r.id = c.root_id
         WHERE c.state = 'active' AND ${COLLECTION_VISIBLE}${scope.ids ? ` AND c.id ${inScope}` : ''}`,
      )
      .all(params) as (CollectionRow & { root_path: string; comic: boolean })[];
    if (!rows.length) return new Map();
    const comics = ComicAreas.load(db);
    for (const r of rows) r.comic = !!comics.of(r.root_id, r.rel_dir);
    const pagesBy = new Map<number, PageRow[]>();
    for (const p of db
      .prepare(
        `SELECT i.id, i.collection_id, i.page_no, i.width, i.height, i.rating, i.content_kind, i.dominant_color, i.tagged_at, i.added_at, i.modified_at,
                ${HAS_CHARACTER('i')} AS has_char
         FROM v_counted_images i WHERE i.collection_id ${inScope} ORDER BY i.collection_id, i.page_no`,
      )
      .all(params) as PageRow[]) {
      const list = pagesBy.get(p.collection_id);
      if (list) list.push(p);
      else pagesBy.set(p.collection_id, [p]);
    }
    const hits = (sql: string) => {
      const m = new Map<number, Map<number, number>>();
      for (const r of db.prepare(sql).all(params) as { c: number; x: number; n: number }[]) {
        const inner = m.get(r.c) ?? new Map<number, number>();
        inner.set(r.x, r.n);
        m.set(r.c, inner);
      }
      return m;
    };
    // 角色命中：只要摘要时只算本子（从本子出发按合集索引找页，几千个组图的页不用碰）。
    // CROSS JOIN 固定先走 collections：不筛选时条件是 dc.id IS NOT NULL，优化器会改从 images 的 excluded_by 索引出发，把 9 万张图过一遍
    // （30–46 ms，固定后约 4 ms）。+i.excluded_by 同理，不让它拿这个索引找页
    const charHits = hits(
      scope.cast
        ? `SELECT i.collection_id AS c, ic.character_id AS x, COUNT(*) AS n FROM v_counted_images i
           JOIN image_characters ic ON ic.image_id = i.id WHERE i.collection_id ${inScope} GROUP BY 1, 2`
        : `SELECT i.collection_id AS c, ic.character_id AS x, COUNT(*) AS n FROM collections dc
           CROSS JOIN images i JOIN image_characters ic ON ic.image_id = i.id
           WHERE dc.kind = 'doujin' AND dc.state = 'active' AND dc.id ${inScope}
             AND i.collection_id = dc.id AND ${LIVE_IMAGES} AND +i.excluded_by IS NULL GROUP BY 1, 2`,
    );
    // 图的作品（imageWorkRows：和 v_image_works 同口径，直接连底表——连视图时 SQLite 会把整个 UNION 视图对每一行重扫一遍，副本上要 11 秒）
    const workHits = scope.works
      ? hits(
          `SELECT c, work_id AS x, COUNT(*) AS n
           FROM (${imageWorkRows('v_counted_images i', `i.collection_id ${inScope}`, 'i.collection_id AS c')})
           GROUP BY c, x`,
        )
      : new Map<number, Map<number, number>>();
    const manual = (table: string, col: string) => {
      const m = new Map<number, number[]>();
      for (const r of db.prepare(`SELECT collection_id AS c, ${col} AS x FROM ${table} ORDER BY added_at, ${col}`).all() as {
        c: number;
        x: number;
      }[])
        m.set(r.c, [...(m.get(r.c) ?? []), r.x]);
      return m;
    };
    const manualChars = manual('collection_characters', 'character_id');
    const manualWorks = manual('collection_works', 'work_id');
    // 角色所属作品直接读 character_works（顺序同 Derived 的 workIds），只有算作品时要（手动关联的角色的作品也并进来）。不用 derived.get()：
    // 侧栏统计也走这里，用户每点一次收藏 Derived 都会失效，为了这张小表整份重建要 1 秒以上
    const workIdsOf = new Map<number, number[]>();
    if (scope.works) {
      const sql = 'SELECT character_id AS c, work_id AS w FROM character_works ORDER BY character_id, position, work_id';
      for (const r of db.prepare(sql).all() as { c: number; w: number }[]) {
        const list = workIdsOf.get(r.c);
        if (list) list.push(r.w);
        else workIdsOf.set(r.c, [r.w]);
      }
    }
    const none = new Map<number, number>();

    const out = new Map<number, Loaded>();
    for (const row of rows) {
      const pages = pagesBy.get(row.id) ?? [];
      const comic = row.comic;
      const s = summarize<number>({
        kind: row.kind as CollectionKind,
        coverImageId: row.cover_image_id,
        reviewed: row.reviewed_at !== null || comic,
        pages: pages.map((p) => ({
          id: p.id,
          width: p.width,
          height: p.height,
          rating: p.rating,
          kind: p.content_kind,
          color: p.dominant_color,
          tagged: p.tagged_at !== null || comic,
          addedAt: p.added_at,
          hasChar: p.has_char === 1,
          modifiedAt: p.modified_at,
        })),
        charHits: charHits.get(row.id) ?? none,
        workHits: workHits.get(row.id) ?? none,
        manualChars: manualChars.get(row.id) ?? [],
        manualWorks: manualWorks.get(row.id) ?? [],
        worksOfCharacter: (id) => workIdsOf.get(id) ?? [],
      });
      out.set(row.id, {
        row,
        pages,
        cast: scope.cast ? s.cast : undefined,
        works: scope.works ? s.works : undefined,
        summary: {
          id: toId(row.id),
          kind: row.kind as CollectionKind,
          title: row.title,
          folderName: leafOf(row.rel_dir),
          event: row.event,
          circle: row.circle,
          artist: row.artist,
          parody: row.parody,
          translator: row.translator,
          seriesKey: row.series_key,
          volumeNo: row.volume_no,
          pageCount: s.pageCount,
          covers: s.covers.map((c) => ({
            imageId: toId(c.imageId),
            rating: c.rating,
            color: c.color ?? DEFAULT_DOMINANT,
            focus: null,
            modifiedAt: c.modifiedAt,
          })),
          coverTagged: s.coverTagged,
          origin: row.origin,
          membership: row.membership ?? 'folder',
          pending: s.pending,
          unrecognizedPageCount: s.unrecognizedPageCount,
          lastAddedAt: s.lastAddedAt,
        },
      });
    }
    return out;
  }

  list(q: ListCollectionsQuery): CollectionSummary[] {
    const cid = q.characterId !== undefined ? parseId(q.characterId) : null;
    const wid = q.workId !== undefined ? parseId(q.workId) : null;
    if ((q.characterId !== undefined && cid === null) || (q.workId !== undefined && wid === null)) return [];
    // 类型、成员来源、系列、搜索在 candidates 里已经筛准了（都是合集行上的字段）；下面只筛要看摘要的：待整理、角色、作品
    let ids = this.candidates(q, cid, wid);
    if (ids && !ids.length) return [];
    // 最近加图的前 limit 本（「收进组图」弹窗）：不看摘要的筛选时，先按页的入库时间挑出来，不用算几千组同投稿的摘要
    if (q.sort === 'recent' && q.limit !== undefined && q.pending === undefined && cid === null && wid === null) {
      ids = this.recentIds(ids, q.limit);
    }
    const out: CollectionSummary[] = [];
    for (const l of this.loadAll({ ids, cast: cid !== null, works: wid !== null }).values()) {
      const s = l.summary;
      if (s.pageCount === 0) continue;
      if (q.pending !== undefined && s.pending !== q.pending) continue;
      let match: number | undefined;
      if (cid !== null) {
        const hit = l.cast!.find((c) => c.id === cid);
        if (!hit) continue;
        match = hit.pageCount;
      }
      if (wid !== null) {
        const hit = l.works!.find((w) => w.id === wid);
        if (!hit) continue;
        match = hit.pageCount;
      }
      out.push(match === undefined ? s : { ...s, matchPageCount: match });
    }
    out.sort(q.sort === 'recent' ? compareRecent : compareSummaries);
    return q.limit !== undefined ? out.slice(0, q.limit) : out;
  }

  /**
   * 列表的筛选先缩小到哪些合集（几个一起给时取交集），没有这些筛选时 undefined = 全部：
   * - 类型、成员来源、系列、搜索是合集行上的字段，在这里就筛准了（合集表只有几千行，按类型、成员来源筛一遍约 1 毫秒，不加索引；
   *   页才是几万行，按 id 走合集的索引读）；
   * - 角色、作品、待整理只缩小范围，留下的合集照常按摘要、出场角色、作品判断，结果和全读一遍一样。
   * 角色和作品从它们的索引出发找页（+i.collection_id：不让查询改走合集的索引把几万页扫一遍）
   */
  private candidates(q: ListCollectionsQuery, cid: number | null, wid: number | null): number[] | undefined {
    const db = this.ctx.db;
    const sets: number[][] = [];
    const ids = (sql: string, params: Record<string, unknown> = {}) => db.prepare(sql).pluck().all(params) as number[];
    const kinds = many(q.kind);
    if (kinds) {
      const sql = "SELECT id FROM collections WHERE kind IN (SELECT value FROM json_each(@v)) AND state = 'active'";
      sets.push(ids(sql, { v: JSON.stringify(kinds) }));
    }
    const memberships = many(q.membership);
    if (memberships) {
      const sql = "SELECT id FROM collections WHERE membership IN (SELECT value FROM json_each(@v)) AND state = 'active'";
      sets.push(ids(sql, { v: JSON.stringify(memberships) }));
    }
    // 待整理只会是本子、画集（domain/collections/summary.ts：组图没有「没认出的页」，pending 恒为 false）
    if (q.pending === true) sets.push(ids("SELECT id FROM collections WHERE kind IN ('doujin', 'artbook') AND state = 'active'"));
    if (q.seriesKey !== undefined) {
      sets.push(ids("SELECT id FROM collections WHERE series_key = @key AND state = 'active'", { key: q.seriesKey }));
    }
    const text = this.searched(q.q);
    if (text) sets.push(text);
    // 角色：这本里有它的页（出场的门槛由摘要判断），或者手动关联了它
    if (cid !== null) {
      sets.push(
        ids(
          `SELECT i.collection_id FROM image_characters ic JOIN v_counted_images i ON i.id = ic.image_id
             WHERE ic.character_id = @cid AND +i.collection_id IS NOT NULL
           UNION SELECT collection_id FROM collection_characters WHERE character_id = @cid`,
          { cid },
        ),
      );
    }
    // 作品：这本里有图的作品是它的页（imageWorkRows，同 v_image_works 口径），手动关联了它，或者手动关联了它的角色（这些角色的作品也算手动的）
    if (wid !== null) {
      sets.push(
        ids(
          `SELECT c FROM (${imageWorkRows('v_counted_images i', '+i.collection_id IS NOT NULL', 'i.collection_id AS c')})
             WHERE work_id = @wid
           UNION SELECT collection_id FROM collection_works WHERE work_id = @wid
           UNION SELECT cc.collection_id FROM collection_characters cc JOIN character_works cw ON cw.character_id = cc.character_id
             WHERE cw.work_id = @wid`,
          { wid },
        ),
      );
    }
    if (!sets.length) return undefined;
    return sets.reduce((a, b) => {
      const keep = new Set(b);
      return a.filter((x) => keep.has(x));
    });
  }

  /**
   * 搜索命中的合集：书名、文件夹名、社团、作者、原作、汉化组，searchKey 归一化后包含（都是合集行上的字段，不用读页）。
   * 没有搜索（或者归一化后是空的）时 undefined = 不筛
   */
  private searched(text: string | undefined): number[] | undefined {
    const k = text ? searchKey(text) : '';
    if (!k) return undefined;
    const rows = this.ctx.db
      .prepare("SELECT id, title, rel_dir, circle, artist, parody, translator FROM collections WHERE state = 'active'")
      .all() as Pick<CollectionRow, 'id' | 'title' | 'rel_dir' | 'circle' | 'artist' | 'parody' | 'translator'>[];
    const hit = (r: (typeof rows)[number]) =>
      [r.title ?? '', leafOf(r.rel_dir), r.circle, r.artist, r.parody, r.translator].some((x) => x && searchKey(x).includes(k));
    return rows.filter(hit).map((r) => r.id);
  }

  /**
   * 最近加图的前 limit 本：按每本可见页里最晚的入库时间（= 摘要的 lastAddedAt）挑，和第 limit 本同时的也留下（最后在摘要上按 compareRecent 排）。
   * 只读页的入库时间（走合集的索引），不算摘要；显示的范围和 loadAll 一样（state、COLLECTION_VISIBLE），页数为 0 的本来就不在里面
   */
  private recentIds(ids: number[] | undefined, limit: number): number[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT p.c, p.at FROM (
           SELECT i.collection_id AS c, MAX(i.added_at) AS at FROM v_counted_images i
           WHERE i.collection_id ${ids ? 'IN (SELECT value FROM json_each(@ids))' : 'IS NOT NULL'} GROUP BY i.collection_id
         ) p JOIN collections c ON c.id = p.c JOIN library_roots r ON r.id = c.root_id
         WHERE c.state = 'active' AND ${COLLECTION_VISIBLE}
         ORDER BY p.at DESC`,
      )
      .all(ids ? { ids: JSON.stringify(ids) } : {}) as { c: number; at: string }[];
    const cut = rows[limit - 1]?.at;
    return (cut === undefined ? rows : rows.filter((x) => x.at >= cut)).map((x) => x.c);
  }

  /**
   * 合集的数目（GET /api/collections/counts）：每一类、每种成员来源的本数、书架格数（同系列两本以上算一格）、页数。
   * 只读合集的行和每本的页数，不算摘要：合集页的副标题、每一类的小字、「另有 N 组同一投稿」不用把几千组的摘要都拉回来。
   * 口径和 list 一样（只数页数 > 0 的；显示范围同 loadAll；q 同 list 的搜索），collections.test.ts 和列表逐项比对
   */
  counts(q: CollectionCountsQuery = {}): CollectionCountsResponse {
    const tally = (): CollectionTally => ({ count: 0, units: 0, pages: 0 });
    const out = Object.fromEntries(
      KINDS.map((k) => [k, { ...tally(), membership: Object.fromEntries(MEMBERSHIPS.map((m) => [m, tally()])) }]),
    ) as CollectionCountsResponse;
    const ids = this.searched(q.q);
    if (ids && !ids.length) return out;
    const rows = this.ctx.db
      .prepare(
        `SELECT c.id, c.kind, c.membership, c.series_key, p.n FROM (
           SELECT i.collection_id AS c, COUNT(*) AS n FROM v_counted_images i
           WHERE i.collection_id ${ids ? 'IN (SELECT value FROM json_each(@ids))' : 'IS NOT NULL'} GROUP BY i.collection_id
         ) p JOIN collections c ON c.id = p.c JOIN library_roots r ON r.id = c.root_id
         WHERE c.state = 'active' AND ${COLLECTION_VISIBLE}`,
      )
      .all(ids ? { ids: JSON.stringify(ids) } : {}) as {
      id: number;
      kind: CollectionKind;
      membership: CollectionMembership | null;
      series_key: string | null;
      n: number;
    }[];
    // 书架格数：同一系列算一格，不在系列里的一本一格（toShelfUnits 的规则）
    const units = new Map<CollectionTally, Set<string>>();
    const add = (t: CollectionTally, unit: string, pages: number) => {
      const seen = units.get(t) ?? new Set<string>();
      units.set(t, seen.add(unit));
      t.count++;
      t.pages += pages;
      t.units = seen.size;
    };
    for (const r of rows) {
      const k = out[r.kind];
      if (!k) continue;
      const unit = r.series_key ?? `c${r.id}`;
      add(k, unit, r.n);
      add(k.membership[r.membership ?? 'folder'], unit, r.n);
    }
    return out;
  }

  /** 一本的摘要（新建之后返回给前端） */
  private summaryOf(id: number): CollectionSummary {
    return this.loadAll({ ids: [id], cast: false, works: false }).get(id)!.summary;
  }

  get(idStr: ID): GetCollectionResponse | null {
    const id = parseId(idStr);
    if (id === null) return null;
    // 只读这一本和同系列的（系列列表要它们的摘要），不读全部合集
    const seriesKey = this.ctx.db.prepare('SELECT series_key FROM collections WHERE id = ?').pluck().get(id) as string | null | undefined;
    if (seriesKey === undefined) return null;
    const ids = seriesKey
      ? (this.ctx.db.prepare("SELECT id FROM collections WHERE series_key = ? AND state = 'active'").pluck().all(seriesKey) as number[])
      : [id];
    const all = this.loadAll({ ids, cast: true, works: true });
    const l = all.get(id);
    if (!l) return null;
    const data = this.derived.get();
    const pages: CollectionPage[] = l.pages.map((p, i) => ({
      imageId: toId(p.id),
      modifiedAt: p.modified_at,
      pageNo: i + 1,
      width: p.width,
      height: p.height,
      rating: p.rating,
      kind: p.content_kind,
      dominantColor: p.dominant_color ?? DEFAULT_DOMINANT,
      tagged: p.tagged_at !== null || l.row.comic,
    }));
    const series = l.row.series_key
      ? [...all.values()]
          .filter((x) => x.row.series_key === l.row.series_key && x.summary.pageCount > 0)
          .map((x) => x.summary)
          .sort((a, b) => (a.volumeNo ?? 0) - (b.volumeNo ?? 0) || Number(a.id) - Number(b.id))
      : [];
    return {
      collection: l.summary,
      pages,
      cast: l.cast!.flatMap((c) => {
        const rec = data.characters.get(c.id);
        return rec ? [{ character: toCharacter(rec), pageCount: c.pageCount, manual: c.manual }] : [];
      }),
      works: l.works!.flatMap((w) => {
        const rec = data.works.get(w.id);
        return rec ? [{ work: toWork(rec), pageCount: w.pageCount, manual: w.manual }] : [];
      }),
      folderPath: l.row.membership === 'folder' ? (l.row.rel_dir ? `${l.row.root_path}/${l.row.rel_dir}` : l.row.root_path) : '',
      pageOrder: l.row.page_order,
      evidence: l.row.evidence,
      reviewed: l.row.reviewed_at !== null,
      series,
    };
  }

  /**
   * getStats 用：页数 > 0 的本数（counts，不算摘要），和待整理条目数（同一系列算一条）。
   * 待整理只会是本子、画集（见 candidates），只算它们的摘要，几千组同投稿的不用算
   */
  stats(): { collectionCounts: Record<CollectionKind, number>; pendingCollectionCount: number } {
    const c = this.counts();
    const pending = new Set<string>();
    for (const s of this.list({ pending: true })) pending.add(s.seriesKey ?? `c${s.id}`);
    return {
      collectionCounts: { doujin: c.doujin.count, artbook: c.artbook.count, group: c.group.count },
      pendingCollectionCount: pending.size,
    };
  }

  // ---------------------------------------------------------------- 修改

  create(body: CreateCollectionBody): MutationResult & { collection: CollectionSummary } {
    if (!isKind(body.kind)) throw new BadRequestError('请选择合集类型');
    if (body.imageIds?.length) return this.createSelected(body);
    if (!body.fromImageId) throw new BadRequestError('请选择图片');
    const iid = parseId(body.fromImageId);
    const img =
      iid === null
        ? undefined
        : (this.ctx.db
            .prepare(`SELECT i.root_id, i.rel_path, i.file_name FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ? AND ${VISIBLE}`)
            .get(iid) as { root_id: number; rel_path: string; file_name: string } | undefined);
    if (!img) throw new NotFoundError('图片');
    const dir = img.rel_path.length > img.file_name.length ? img.rel_path.slice(0, img.rel_path.length - img.file_name.length - 1) : '';
    // 按漫画导入的文件夹根目录直接放页时，根目录也能成一本
    if (!dir && !ComicAreas.load(this.ctx.db).of(img.root_id, '')) throw new BadRequestError('图库根目录里的图不能成册');
    const db = this.ctx.db;
    const ex = db.prepare('SELECT * FROM collections WHERE root_id = ? AND rel_dir = ?').get(img.root_id, dir) as CollectionRow | undefined;
    if (ex?.state === 'active') throw new ConflictError('这个文件夹已经是合集');
    const now = iso(this.ctx.clock());
    const members = this.members(img.root_id, dir);
    if (body.organizeFiles) assertOrganizeReady(this.ctx, members.map(m => m.page.id));
    let collectionId = 0;
    const result = this.ctx.mutate((u) => {
      if (ex) {
        u.columns('collections', MUTABLE, [ex.id]);
        db.prepare(
          `UPDATE collections SET state = 'active', kind = ?, kind_manual = 1, kind_source = 'manual', origin = 'manual', updated_at = ? WHERE id = ?`,
        ).run(body.kind, now, ex.id);
        collectionId = ex.id;
      } else {
        const leaf = bookLeaf(dir);
        const p = this.parsedFor(img.root_id, dir);
        const order = decideCollection(leaf, dirFeatures(members.map((m) => m.page)))?.pageOrder ?? 'name';
        collectionId = Number(
          db
            .prepare(
              `INSERT INTO collections (root_id, rel_dir, kind, kind_source, kind_manual, title, event, circle, artist, parody, translator,
                 series_key, volume_no, page_order, origin, state, evidence, created_at, updated_at)
               VALUES (@root, @dir, @kind, 'manual', 1, @title, @event, @circle, @artist, @parody, @translator,
                 @seriesKey, @volumeNo, @order, 'manual', 'active', '手动成册', @now, @now)`,
            )
            .run({ root: img.root_id, dir, kind: body.kind, order, now, ...p }).lastInsertRowid,
        );
        u.inserted('collections', collectionId);
      }
      u.columns('images', ['collection_id', 'page_no', 'collection_detached'], members.map((m) => m.page.id));
      db.prepare('UPDATE images SET collection_detached = 0 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(members.map(m => m.page.id)));
      const n = this.service.assignPages(collectionId).length;
      this.membersChanged(members.map((m) => m.page.id));
      return { message: `已把「${leafOf(dir)}」做成${KIND_LABEL[body.kind]}（${n} 页）` };
    });
    if (body.organizeFiles) {
      const detached = this.update(String(collectionId), { organizeFiles: true });
      const combined = this.ctx.undo.result(detached.message, async () => { if (detached.undoToken) await this.ctx.undo.run(detached.undoToken); if (result.undoToken) await this.ctx.undo.run(result.undoToken); });
      return { ...combined, collection: this.summaryOf(collectionId) };
    }
    return { ...result, collection: this.summaryOf(collectionId) };
  }

  private memberCollections(ids: number[]): number[] {
    return this.ctx.db.prepare('SELECT DISTINCT collection_id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND collection_id IS NOT NULL').pluck().all(JSON.stringify(ids)) as number[];
  }

  /** 成员变了的合集（包括成员被挪走的那几本）：声明变化，由反应按页序重新编号；撤销时重放，还原后再编一次 */
  private renumber(collections: number[]): void {
    this.ctx.changed({ type: 'collections.changed', ids: [], collectionIds: collections });
  }

  /** 这些图进出了本子 / 画集、或者所在合集的类型变了：「整本处理」变了，Pixiv 补充资格由反应重新登记（附录 #19） */
  private membersChanged(ids: number[]): void {
    this.ctx.changed({ type: 'collections.changed', ids, collectionIds: [] });
  }

  private selectedImages(ids: ID[]): number[] {
    const nums = [...new Set(ids.map(parseId))];
    if (!nums.length || nums.some(n => n === null)) throw new BadRequestError('请选择有效图片');
    const found = this.ctx.db.prepare('SELECT id FROM v_counted_images WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(nums)) as number[];
    if (found.length !== nums.length) throw new BadRequestError('部分图片已不可用，请刷新后重试');
    return nums as number[];
  }

  private createSelected(body: CreateCollectionBody): MutationResult & { collection: CollectionSummary } {
    const ids = this.selectedImages(body.imageIds!);
    const db = this.ctx.db;
    if (body.organizeFiles) assertOrganizeReady(this.ctx, ids);
    const donors = this.memberCollections(ids);
    const root = db.prepare('SELECT root_id FROM images WHERE id = ?').pluck().get(ids[0]) as number;
    const now = iso(this.ctx.clock());
    let id = 0;
    const r = this.ctx.mutate(u => {
      // Record member restoration before insertion so undo restores members after removing the new collection.
      u.columns('images', ['collection_id', 'page_no', 'collection_detached'], ids);
      id = Number(db.prepare(`INSERT INTO collections (root_id, rel_dir, kind, kind_source, kind_manual, title, title_manual,
        page_order, origin, state, created_at, updated_at, membership)
        VALUES (?, ?, ?, 'manual', 1, ?, 1, 'name', 'manual', 'active', ?, ?, 'selection')`).run(
          root, '@selection/' + randomUUID(), body.kind, body.title?.trim() || '新组图', now, now).lastInsertRowid);
      u.inserted('collections', id);
      db.prepare('UPDATE images SET collection_id = ?, collection_detached = 1 WHERE id IN (SELECT value FROM json_each(?))').run(id, JSON.stringify(ids));
      this.service.assignPages(id);
      this.renumber(donors);
      this.membersChanged(ids);
      return { message: `已新建${KIND_LABEL[body.kind]}「${body.title?.trim() || '新组图'}」，收进 ${ids.length} 张` };
    });
    return { ...(body.organizeFiles ? organizeCollection(this.ctx, id, r) : r), collection: this.summaryOf(id) };
  }

  update(idStr: ID, body: UpdateCollectionBody): MutationResult {
    const c = this.requireActive(idStr);
    const db = this.ctx.db;
    const now = iso(this.ctx.clock());
    const leaf = bookLeaf(c.rel_dir);
    const set: Record<string, unknown> = {};
    const notes: string[] = [];
    let reorder = false;
    const add = body.addImageIds ? this.selectedImages(body.addImageIds) : [];
    const remove = body.removeImageIds ? this.selectedImages(body.removeImageIds) : [];
    const donors = this.memberCollections([...add, ...remove]);
    if (add.some(id => remove.includes(id))) throw new BadRequestError('同一张图不能同时添加和移出');
    // 按文件夹成册的本子 / 画集跟着文件夹走：只能移出页（记成 detached），不能收别处的图、不能整理到子文件夹。
    // 改成 selection 会让这一行继续占着 (root_id, rel_dir)，之后这个文件夹再成册时撞 UNIQUE（启动时全量重算会失败）。
    const folder = c.membership === 'folder';
    if (folder && (add.length || body.organizeFiles)) {
      throw new BadRequestError('按文件夹成册的本子和画集跟着文件夹走，不能收进别处的图；可以选图另建组图');
    }
    if (add.length || remove.length) {
      if (!folder) set.membership = 'selection';
      reorder = true;
      notes.push(add.length && remove.length ? '已更新组图' : add.length ? `已加入 ${add.length} 张` : `已移出 ${remove.length} 张`);
    }

    if (body.title !== undefined) {
      if (body.title === null) {
        Object.assign(set, { title: this.parsedFor(c.root_id, c.rel_dir).title, title_manual: 0 });
        notes.push('已恢复自动名');
      } else {
        const t = body.title.trim();
        if (!t) throw new BadRequestError('名字不能为空');
        Object.assign(set, { title: t.normalize('NFC'), title_manual: 1 });
        notes.push(`已改名为《${t}》`);
      }
    }
    if (body.kind !== undefined) {
      if (body.kind === 'auto') {
        const members = this.members(c.root_id, c.rel_dir).map((m) => m.page);
        const f = dirFeatures(members);
        const rule = ComicAreas.load(db).of(c.root_id, c.rel_dir) ? 'H' : members.length ? (decideCollection(leaf, f)?.rule ?? null) : null;
        const k = autoKind(leaf, f, rule);
        Object.assign(set, { kind: k.kind, kind_source: k.source, kind_manual: 0 });
        notes.push(`已恢复自动判断（${KIND_LABEL[k.kind]}）`);
      } else {
        if (!isKind(body.kind)) throw new BadRequestError('请选择合集类型');
        Object.assign(set, { kind: body.kind, kind_source: 'manual', kind_manual: 1 });
        notes.push(`已改为${KIND_LABEL[body.kind]}`);
      }
    }
    if (body.coverImageId !== undefined) {
      if (body.coverImageId === null) set.cover_image_id = null;
      else {
        const pid = parseId(body.coverImageId);
        if (pid === null || !db.prepare('SELECT 1 FROM images WHERE id = ? AND collection_id = ?').get(pid, c.id)) {
          throw new BadRequestError('封面必须是这本里的一页');
        }
        set.cover_image_id = pid;
      }
      notes.push(body.coverImageId === null ? '已恢复自动封面' : '已换封面');
    }
    if (body.pageOrder !== undefined) {
      if (body.pageOrder !== 'name' && body.pageOrder !== 'mtime') throw new BadRequestError('页序只能是文件名或修改时间');
      set.page_order = body.pageOrder;
      reorder = true;
      notes.push(body.pageOrder === 'name' ? '已改为按文件名排页' : '已改为按修改时间排页');
    }
    if (body.seriesKey !== undefined || body.volumeNo !== undefined) {
      if (body.seriesKey === null) {
        const p = this.parsedFor(c.root_id, c.rel_dir);
        Object.assign(set, { series_key: p.seriesKey, volume_no: p.volumeNo, series_manual: 0 });
      } else {
        Object.assign(set, {
          series_key: body.seriesKey !== undefined ? body.seriesKey.trim() || null : c.series_key,
          volume_no: body.volumeNo !== undefined ? body.volumeNo : c.volume_no,
          series_manual: 1,
        });
      }
      notes.push('已更新系列');
    }
    if (body.reviewed !== undefined) {
      set.reviewed_at = body.reviewed ? now : null;
      notes.push(body.reviewed ? '已标为已整理' : '已标为待整理');
    }
    const chars = body.manualCharacterIds?.map((x) => this.requireRow('characters', x, '角色'));
    const works = body.manualWorkIds?.map((x) => this.requireRow('works', x, '作品'));
    if (chars) notes.push('已更新出场角色');
    if (works) notes.push('已更新作品');
    if (body.organizeFiles) {
      assertOrganizeReady(this.ctx, [...add, ...(db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[])]);
      notes.push('整理到子文件夹');
    }
    if (!notes.length) throw new BadRequestError('没有要修改的内容');

    const result = this.ctx.mutate((u) => {
      u.columns('collections', MUTABLE, [c.id]);
      if (add.length || remove.length) {
        const existing = db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[];
        u.columns('images', ['collection_id', 'page_no', 'collection_detached'], [...new Set([...existing, ...add, ...remove])]);
        // 手选 / 同投稿的组：成员都记成手动，扫描和同投稿聚合不再动它们。文件夹书的其余页照常跟着文件夹
        if (!folder) db.prepare('UPDATE images SET collection_detached = 1 WHERE collection_id = ?').run(c.id);
        db.prepare('UPDATE images SET collection_id = ?, collection_detached = 1 WHERE id IN (SELECT value FROM json_each(?))').run(c.id, JSON.stringify(add));
        db.prepare('UPDATE images SET collection_id = NULL, page_no = NULL, collection_detached = 1 WHERE collection_id = ? AND id IN (SELECT value FROM json_each(?))').run(c.id, JSON.stringify(remove));
        if (c.source_key) { u.columns('collections', ['source_key'], [c.id]); set.source_key = null; }
      }
      this.write(c.id, { ...set, origin: 'manual', updated_at: now });
      if (chars) this.replaceLinks(u, 'collection_characters', 'character_id', c.id, chars, now);
      if (works) this.replaceLinks(u, 'collection_works', 'work_id', c.id, works, now);
      if (reorder) {
        u.columns('images', ['collection_id', 'page_no'], db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[]);
        this.service.assignPages(c.id);
      }
      if (add.length || remove.length) this.renumber([...new Set([...donors, c.id])]);
      if (add.length || remove.length || set.kind !== undefined) {
        this.membersChanged([...new Set([...(db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[]), ...add, ...remove])]);
      }
      return { message: notes.join('，') };
    });
    return body.organizeFiles ? organizeCollection(this.ctx, c.id, result) : result;
  }

  /** 不成册：留一行 dismissed，自动判定不会再建 */
  dismiss(idStr: ID): MutationResult {
    const c = this.requireActive(idStr);
    const db = this.ctx.db;
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      const members = db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[];
      u.columns('collections', MUTABLE, [c.id]);
      u.columns('images', ['collection_id', 'page_no', 'collection_detached'], members);
      this.write(c.id, { state: 'dismissed', origin: 'manual', updated_at: now });
      this.membersChanged(members);
      db.prepare('UPDATE images SET collection_id = NULL, page_no = NULL, collection_detached = 1 WHERE collection_id = ?').run(c.id);
      const title = collectionTitle({ title: c.title, folderName: leafOf(c.rel_dir) });
      const kind = KIND_LABEL[c.kind as CollectionKind] ?? '组图';
      return { message: c.membership === 'folder' ? `已取消成册：${title}` : `已解散${kind}：${title}（图片都还在）` };
    });
  }

  bulk(body: BulkCollectionsBody): MutationResult {
    const rows = [...new Set(body.ids)].map((x) => this.requireActive(x));
    const now = iso(this.ctx.clock());
    const a = body.action;
    if (a.type === 'kind' && !isKind(a.value)) throw new BadRequestError('请选择合集类型');
    const ids = rows.map((r) => r.id);
    return this.ctx.mutate((u) => {
      const characterId = a.type === 'addCharacter' ? this.requireRow('characters', a.characterId, '角色')
        : a.type === 'addCharacterTag' ? resolveSuggestedCharacter(this.ctx, u, this.catalog(), a.danbooruTag, now) : null;
      const target = characterId !== null
        ? { id: characterId, table: 'collection_characters' as const, col: 'character_id' }
        : a.type === 'addWork'
          ? { id: this.requireRow('works', a.workId, '作品'), table: 'collection_works' as const, col: 'work_id' }
          : null;
      u.columns('collections', MUTABLE, ids);
      for (const r of rows) {
        if (a.type === 'review') this.write(r.id, { reviewed_at: now, origin: 'manual', updated_at: now });
        else if (a.type === 'kind') {
          this.write(r.id, { kind: a.value, kind_source: 'manual', kind_manual: 1, origin: 'manual', updated_at: now });
          this.membersChanged(this.ctx.db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(r.id) as number[]);
        }
        else this.write(r.id, { origin: 'manual', updated_at: now });
      }
      if (target) {
        const name = target.table as 'collection_characters' | 'collection_works';
        u.set(name, `${target.col} = ? AND collection_id IN (SELECT value FROM json_each(?))`, [target.id, JSON.stringify(ids)]);
        const ins = this.ctx.db.prepare(`INSERT OR IGNORE INTO ${name} (collection_id, ${target.col}, added_at) VALUES (?, ?, ?)`);
        for (const id of ids) ins.run(id, target.id, now);
      }
      const n = ids.length;
      const label =
        a.type === 'review'
          ? `已把 ${n} 本标为已整理`
          : a.type === 'kind'
            ? `已把 ${n} 本改为${KIND_LABEL[a.value]}`
            : `已把 ${n} 本关联到「${this.nameOf(target!.table === 'collection_characters' ? 'characters' : 'works', target!.id)}」`;
      return { message: label };
    });
  }

  // ---------------------------------------------------------------- 内部

  /** 自动的书名、系列、卷号：按漫画导入的文件夹看各级目录名，其余看书名目录（跳过 images、pics 这类） */
  private parsedFor(rootId: number, dir: string) {
    const area = ComicAreas.load(this.ctx.db).of(rootId, dir);
    return area ? parseComicDir(ComicAreas.relIn(area, dir), area.path) : parseBookDir(dir, bookLeaf(dir));
  }

  private members(root: number, dir: string): { page: DirPage }[] {
    const rows = this.ctx.db.prepare(DIR_MEMBERS).all({ root, dir }) as {
      id: number;
      file_name: string;
      width: number;
      height: number;
      modified_at: string;
      content_kind: string;
      content_kind_source: string | null;
      content_kind_manual: number;
      animated: number;
      tagged_at: string | null;
    }[];
    return rows.map((r) => ({
      page: {
        id: r.id,
        fileName: r.file_name,
        width: r.width,
        height: r.height,
        modifiedAt: r.modified_at,
        kind: r.content_kind,
        animated: r.animated === 1,
        judged: isJudged(r),
      },
    }));
  }

  private requireActive(idStr: ID): CollectionRow {
    const id = parseId(idStr);
    // 文件夹停用、移除期间合集还在（见 CollectionService），但和列表、详情一样当作不存在
    const row =
      id === null
        ? undefined
        : (this.ctx.db
            .prepare(
              `SELECT c.* FROM collections c JOIN library_roots r ON r.id = c.root_id
               WHERE c.id = ? AND c.state = 'active' AND ${COLLECTION_VISIBLE}`,
            )
            .get(id) as CollectionRow | undefined);
    if (!row) throw new NotFoundError('合集');
    return row;
  }

  private requireRow(table: 'characters' | 'works', idStr: ID, label: string): number {
    const id = parseId(idStr);
    if (id === null || !this.ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new NotFoundError(label);
    return id;
  }

  private nameOf(table: 'characters' | 'works', id: number): string {
    return this.ctx.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).pluck().get(id) as string;
  }

  private write(id: number, set: Record<string, unknown>): void {
    const cols = Object.keys(set);
    this.ctx.db.prepare(`UPDATE collections SET ${cols.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...set, id });
  }

  private replaceLinks(
    u: UndoRecorder,
    table: 'collection_characters' | 'collection_works',
    col: string,
    id: number,
    targets: number[],
    now: string,
  ): void {
    u.set(table, 'collection_id = ?', [id]);
    this.ctx.db.prepare(`DELETE FROM ${table} WHERE collection_id = ?`).run(id);
    const ins = this.ctx.db.prepare(`INSERT OR IGNORE INTO ${table} (collection_id, ${col}, added_at) VALUES (?, ?, ?)`);
    for (const t of new Set(targets)) ins.run(id, t, now);
  }
}
