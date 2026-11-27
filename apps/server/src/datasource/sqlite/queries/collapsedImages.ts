import { AUTO_COLLAPSE_MIN, BUILTIN_DEFAULT_SORT, type CollectionKind, type ImageItem, type ListImagesQuery, type Page } from '@emaki/shared';
import type { Db } from '../../../db/connection.ts';
import { loadImageItems } from '../hydrate.ts';
import { decodeCursor, encodeCursor } from '../sql.ts';

/** 收拢后的游标带 'g' 标记：和逐张列表的 [值, id] 游标区分开 */
type GroupCursor = ['g', string | number, number];
const isGroupCursor = (x: unknown): x is GroupCursor =>
  Array.isArray(x) && x.length === 3 && x[0] === 'g' && (typeof x[1] === 'string' || typeof x[1] === 'number') && typeof x[2] === 'number';

/**
 * 这一页要不要收拢。'auto'：第一页看结果张数（超过 AUTO_COLLAPSE_MIN 才收拢）；翻页时看游标，沿用第一页的决定，
 * 免得滚动途中结果数跨过门槛，游标对不上。
 */
export function decideCollapse(mode: boolean | 'auto' | undefined, cursor: string | undefined, total: number): boolean {
  if (mode !== 'auto') return !!mode;
  if (!cursor) return total > AUTO_COLLAPSE_MIN;
  try {
    return isGroupCursor(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    return false;
  }
}

/** 一页里的一项：单张（group_id 为空，group_key = 图片 id）或一组（group_key = -合集 id，id 是代表图） */
interface CollapsedRow {
  id: number;
  group_id: number | null;
  group_key: number;
  group_sort: string | number;
  group_title: string | null;
  group_kind: CollectionKind;
  group_favorite: number;
  member_ids: string;
}

/** 测试用：强制走整体分组的写法，拿来和快速路径逐页对比 */
let wholeForTests = false;
export const useWholeCollapseForTests = (on: boolean) => {
  wholeForTests = on;
};

const SORT_COLUMN = { addedAt: 'i.added_at', modifiedAt: 'i.modified_at', fileName: 'i.file_name', bytes: 'i.bytes' } as const;

/**
 * 收拢组图：同一组的图在列表里只占一格（代表图），按组里最靠前的那张排序。
 * 只收拢 kind='group'：本子、画集的页在图库里照常逐张平铺（TASKS「第二轮的默认决定」）。
 *
 * pageWhere 是翻页写法的条件（沿排序索引走，找够一页就停），countWhere 是数总数的写法（先按索引找出命中的图），
 * 两者筛的是同一批图。随机排序走 collapsedImagesWhole（整体分组再排），其余排序走快速路径：
 * 组图的成员只有几百张，先单独把命中的组算出来（排序值、代表图、成员），单张直接沿排序索引取一页，再按同样的顺序合在一起。
 * 以前每一页都要把全库命中的图整体分组、开窗、排序，9 万张的库每页 0.2–0.7 秒；
 * 后台任务每 3 秒推一次变化，前端重拉已加载的每一页，后端几乎一直被这些查询占着（看图、筛选跟着变慢）。
 */
export function collapsedImages(
  db: Db,
  q: ListImagesQuery,
  pageWhere: string,
  countWhere: string,
  params: Record<string, unknown>,
  total: number,
): Page<ImageItem> {
  const sort = q.sort === 'page' ? 'addedAt' : (q.sort ?? BUILTIN_DEFAULT_SORT);
  if (sort === 'random' || wholeForTests) return collapsedImagesWhole(db, q, countWhere, params, total);
  const column = SORT_COLUMN[sort];
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const cmp = dir === 'ASC' ? '>' : '<';
  const collate = sort === 'fileName' ? ' COLLATE NOCASE' : '';
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  const cursor = decodeCursor(q.cursor, isGroupCursor);

  // 命中的组：从组图出发找成员（CROSS JOIN 固定先走 collections，成员走 idx_images_collection）
  const groups = db
    .prepare(
      `WITH m AS (
        SELECT i.id, i.collection_id AS cid, i.page_no, i.favorite, ${column} AS sort_value,
          CASE WHEN i.id = c.cover_image_id THEN 0 ELSE 1 END AS cover_priority
        FROM collections c CROSS JOIN images i
        WHERE c.state = 'active' AND c.kind = 'group' AND i.collection_id = c.id AND ${countWhere}
      )
      SELECT m.cid, ${dir === 'ASC' ? 'MIN' : 'MAX'}(m.sort_value${collate}) AS group_sort, MIN(m.favorite) AS group_favorite,
        COUNT(*) AS n, json_group_array(m.id ORDER BY m.page_no, m.id) AS member_ids,
        (SELECT m2.id FROM m m2 WHERE m2.cid = m.cid ORDER BY m2.cover_priority, m2.page_no, m2.id LIMIT 1) AS rep_id
      FROM m GROUP BY m.cid`,
    )
    .all(params) as { cid: number; group_sort: string | number; group_favorite: number; n: number; member_ids: string; rep_id: number }[];
  const grouped = groups.reduce((a, g) => a + g.n, 0);
  const displayTotal = total - grouped + groups.length;

  // 单张：不在任何组图里的图，沿排序索引取够一页（和逐张列表同一种写法）
  const sortExpr = `${column}${collate}`;
  const singlesAfter = cursor ? `AND (${sortExpr} ${cmp} @value OR (${sortExpr} = @value AND i.id ${cmp} @key))` : '';
  const groupsAfter = cursor ? `AND (g.sort_value${collate} ${cmp} @value OR (g.sort_value${collate} = @value AND g.key ${cmp} @key))` : '';
  const page = db
    .prepare(
      `SELECT key, sort_value FROM (
        SELECT * FROM (
          SELECT i.id AS key, ${column} AS sort_value FROM images i
          WHERE ${pageWhere}
            AND NOT EXISTS (SELECT 1 FROM collections gc WHERE gc.id = i.collection_id AND gc.state = 'active' AND gc.kind = 'group')
            ${singlesAfter}
          ORDER BY ${sortExpr} ${dir}, i.id ${dir} LIMIT @lim
        )
        UNION ALL
        SELECT g.key, g.sort_value FROM (
          SELECT -json_extract(value, '$[0]') AS key, json_extract(value, '$[1]') AS sort_value FROM json_each(@groups)
        ) g WHERE 1 ${groupsAfter}
      ) ORDER BY sort_value${collate} ${dir}, key ${dir} LIMIT @lim`,
    )
    .all({
      ...params,
      groups: JSON.stringify(groups.map((g) => [g.cid, g.group_sort])),
      ...(cursor ? { value: cursor[1], key: cursor[2] } : {}),
      lim: limit + 1,
    }) as { key: number; sort_value: string | number }[];

  const byCid = new Map(groups.map((g) => [g.cid, g]));
  const meta = db.prepare('SELECT title, kind FROM collections WHERE id = ?');
  const rows: CollapsedRow[] = page.map((r) => {
    if (r.key > 0)
      return { id: r.key, group_id: null, group_key: r.key, group_sort: r.sort_value, group_title: null, group_kind: 'group', group_favorite: 0, member_ids: '[]' };
    const g = byCid.get(-r.key)!;
    const c = meta.get(g.cid) as { title: string | null; kind: CollectionKind };
    return { id: g.rep_id, group_id: g.cid, group_key: r.key, group_sort: g.group_sort, group_title: c.title, group_kind: c.kind, group_favorite: g.group_favorite, member_ids: g.member_ids };
  });
  return finishPage(db, q, rows, limit, total, displayTotal);
}

/** 整体分组再分页（随机排序用：随机顺序没有索引可走，本来就要整体排） */
function collapsedImagesWhole(
  db: Db,
  q: ListImagesQuery,
  where: string,
  params: Record<string, unknown>,
  total: number,
): Page<ImageItem> {
  const sort = q.sort === 'page' ? 'addedAt' : (q.sort ?? BUILTIN_DEFAULT_SORT);
  const expr = {
    addedAt: 'i.added_at',
    modifiedAt: 'i.modified_at',
    fileName: 'i.file_name',
    bytes: 'i.bytes',
    random: '(((i.id + @groupSeed) * 2654435761) % 4294967296)',
  }[sort];
  const dir = q.order === 'asc' || sort === 'random' ? 'ASC' : 'DESC';
  const cmp = dir === 'ASC' ? '>' : '<';
  const collate = sort === 'fileName' ? ' COLLATE NOCASE' : '';
  const matched = `WITH matched AS (
    SELECT i.id, i.page_no, i.favorite, c.id AS group_id, c.title AS group_title, c.kind AS group_kind,
      CASE WHEN c.id IS NOT NULL THEN -c.id ELSE i.id END AS group_key,
      ${expr} AS sort_value, CASE WHEN i.id = c.cover_image_id THEN 0 ELSE 1 END AS cover_priority
    FROM images i LEFT JOIN collections c ON c.id = i.collection_id AND c.state = 'active' AND c.kind = 'group'
    WHERE ${where}
  )`;
  const cte = `${matched}, grouped AS (
    SELECT group_key, ${dir === 'ASC' ? 'MIN' : 'MAX'}(sort_value${collate}) AS group_sort,
      MIN(favorite) AS group_favorite,
      json_group_array(id ORDER BY page_no, id) AS member_ids
    FROM matched GROUP BY group_key
  ), ranked AS (
    SELECT id, group_id, group_key, group_title, group_kind,
      ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY cover_priority, page_no ASC, id ASC) AS rn
    FROM matched
  )`;
  const p = { ...params, ...(sort === 'random' ? { groupSeed: q.seed ?? 0 } : {}) };
  const displayTotal = (db.prepare(`${matched} SELECT COUNT(DISTINCT group_key) n FROM matched`).get(p) as { n: number }).n;
  const cursor = decodeCursor(q.cursor, isGroupCursor);
  const after = cursor ? `AND (g.group_sort${collate} ${cmp} @value OR (g.group_sort${collate} = @value AND r.group_key ${cmp} @key))` : '';
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  const rows = db
    .prepare(
      `${cte} SELECT r.*, g.group_sort, g.group_favorite, g.member_ids
    FROM ranked r JOIN grouped g ON g.group_key = r.group_key WHERE r.rn = 1 ${after}
    ORDER BY g.group_sort${collate} ${dir}, r.group_key ${dir} LIMIT @lim`,
    )
    .all({ ...p, ...(cursor ? { value: cursor[1], key: cursor[2] } : {}), lim: limit + 1 }) as CollapsedRow[];
  return finishPage(db, q, rows, limit, total, displayTotal);
}

/** 一页收拢的结果补全字段：组图那一格带上成员和张数（rows 多取了一行，用来判断还有没有下一页） */
function finishPage(db: Db, q: ListImagesQuery, rows: CollapsedRow[], limit: number, total: number, displayTotal: number): Page<ImageItem> {
  const more = rows.length > limit;
  if (more) rows.pop();
  const groupIds = rows.flatMap((row) => (row.group_id === null ? [] : [row.group_id]));
  const wholeMembers = q.includeWholeCollections
    ? ', json_group_array(id ORDER BY page_no, id) AS member_ids, MIN(favorite) AS all_favorite'
    : '';
  const collections = new Map(
    (
      db
        .prepare(
          `SELECT collection_id, COUNT(*) AS total${wholeMembers} FROM v_counted_images
    WHERE collection_id IN (SELECT value FROM json_each(?)) GROUP BY collection_id`,
        )
        .all(JSON.stringify(groupIds)) as {
        collection_id: number;
        total: number;
        member_ids?: string;
        all_favorite?: number;
      }[]
    ).map((row) => [row.collection_id, row]),
  );
  const items = loadImageItems(
    db,
    rows.map((r) => r.id),
  ).map((image, n) => {
    const row = rows[n]!;
    if (row.group_id === null) return image;
    const collection = collections.get(row.group_id);
    if (!collection || collection.total <= 1) return image;
    const memberIds = (JSON.parse(collection.member_ids ?? row.member_ids) as number[]).map(String);
    return {
      ...image,
      collectionGroup: {
        id: String(row.group_id),
        title: row.group_title,
        kind: row.group_kind,
        count: memberIds.length,
        total: collection.total,
        allFavorite: (collection.all_favorite ?? row.group_favorite) === 1,
        memberIds,
      },
    };
  });
  const last = rows.at(-1);
  return { items, total, displayTotal, collapsed: true, nextCursor: more && last ? encodeCursor(['g', last.group_sort, last.group_key]) : null };
}
