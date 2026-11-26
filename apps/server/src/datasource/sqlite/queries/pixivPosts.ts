/**
 * 这些 Pixiv 作品在图库里各有几张（images.pixivPosts）：Pixiv 浏览插件标「已下载」「下了 2/5 张」用，
 * 不管是它下的还是别的工具下的——认的是图片的来源（文件名、Pixiv 证据给的作品号）。
 * - 张数按不同的文件内容（sha256）数：同一页的完全重复只算一张；回收站里的、文件不在了的、在停用的图库文件夹里的不算（LIVE_IMAGES），排除了的算（文件还在）；
 * - pages 是 Emaki 查 Pixiv 标签时缓存的页数（pixiv_artwork_cache），没缓存过的是 null。
 * 走 idx_images_post，500 个作品号不到 1 毫秒（2026-11-26 在 2.3 万张 Pixiv 图的真实库上量的）
 */
import type { Db } from '../../../db/connection.ts';
import { LIVE_IMAGES } from '../../../readmodel/terms.ts';

export interface PixivPost {
  /** 图库里有几张（不同内容的） */
  images: number;
  /** 其中几张是动图 */
  animated: number;
  /** 这个作品一共几页（不知道是 null） */
  pages: number | null;
}

export function pixivPosts(db: Db, ids: readonly string[]): Record<string, PixivPost> {
  const out: Record<string, PixivPost> = {};
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const marks = unique.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT i.source_post_id AS id, COUNT(DISTINCT i.sha256) AS images, COUNT(DISTINCT CASE WHEN i.animated = 1 THEN i.sha256 END) AS animated
       FROM images i
       WHERE i.source_site = 'pixiv' AND i.source_post_id IN (${marks}) AND ${LIVE_IMAGES}
       GROUP BY i.source_post_id`,
    )
    .all(...unique) as { id: string; images: number; animated: number }[];
  if (!rows.length) return out;
  const pages = new Map(
    (
      db
        .prepare(`SELECT post_id AS id, json_extract(artwork, '$.pageCount') AS pages FROM pixiv_artwork_cache WHERE post_id IN (${rows.map(() => '?').join(',')})`)
        .all(...rows.map((r) => r.id)) as { id: string; pages: unknown }[]
    ).map((r) => [r.id, typeof r.pages === 'number' && r.pages > 0 ? r.pages : null]),
  );
  for (const r of rows) out[r.id] = { images: r.images, animated: r.animated, pages: pages.get(r.id) ?? null };
  return out;
}
