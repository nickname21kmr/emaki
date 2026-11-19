/** 搜索联想用的标签张数缓存（tags.image_count，证据模块的表）：图库有变化只标记过期，下次搜索时再刷新 */
import type { Db } from '../../db/connection.ts';
import { NOT_COUNTED } from '../../readmodel/terms.ts';

/**
 * tags.image_count = 每个标签在计入张数的图（v_counted_images）里出现几次。
 * 不从图出发联 image_tags 再分组（330 万行进临时 B 树，真实库 3.5–6 秒）：
 * 先沿 idx_image_tags_tag_score 按 tag_id 顺序数总数，再减去不计数的图（排除、回收站、丢失、文件夹停用，几千张）的标签。
 * 只写张数变了的行。真实库约 0.6–1 秒，结果和原来逐个一致
 */
export function refreshTagCounts(db: Db): void {
  db.transaction(() => {
    const n = new Map<number, number>();
    for (const [id, c] of db.prepare('SELECT tag_id, COUNT(*) FROM image_tags INDEXED BY idx_image_tags_tag_score GROUP BY tag_id').raw().all() as [
      number,
      number,
    ][]) {
      n.set(id, c);
    }
    // 条件是「计入统计」的反面（NOT_COUNTED）；LEFT JOIN 是为了文件夹行不在的图也算不计数（视图里是内连接）
    for (const [id, c] of db
      .prepare(
        `SELECT it.tag_id, COUNT(*) FROM images i LEFT JOIN library_roots r ON r.id = i.root_id
         CROSS JOIN image_tags it ON it.image_id = i.id
         WHERE ${NOT_COUNTED()}
         GROUP BY it.tag_id`,
      )
      .raw()
      .all() as [number, number][]) {
      n.set(id, (n.get(id) ?? 0) - c);
    }
    const update = db.prepare('UPDATE tags SET image_count = ? WHERE id = ?');
    for (const [id, cur] of db.prepare('SELECT id, image_count FROM tags').raw().all() as [number, number][]) {
      const v = n.get(id) ?? 0;
      if (v !== cur) update.run(v, id);
    }
  })();
}
