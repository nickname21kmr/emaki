import { AUTO_COLLAPSE_MIN, type CollectionKind, type ImageItem, type ListImagesQuery, type Page } from '@emaki/shared';
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

/**
 * 收拢组图：先按当前筛选分组再分页，只给最后一页补全字段。
 * 只收拢 kind='group'：本子、画集的页在图库里照常逐张平铺（TASKS「第二轮的默认决定」）。
 */
export function collapsedImages(
  db: Db,
  q: ListImagesQuery,
  where: string,
  params: Record<string, unknown>,
  total: number,
): Page<ImageItem> {
  const sort = q.sort === 'page' ? 'addedAt' : (q.sort ?? 'addedAt');
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
    .all({ ...p, ...(cursor ? { value: cursor[1], key: cursor[2] } : {}), lim: limit + 1 }) as {
    id: number;
    group_id: number | null;
    group_key: number;
    group_sort: string | number;
    group_title: string | null;
    group_kind: CollectionKind;
    group_favorite: number;
    member_ids: string;
  }[];
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
