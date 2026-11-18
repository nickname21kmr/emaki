/**
 * 图库文件夹合并、接管时合集跟着走（合集模块的表；由图库与文件模块的 roots.ts 调用，P4a）。
 * 合集按 (root_id, rel_dir) 定位：子文件夹并进父文件夹时 rel_dir 补上前缀，接管移除过的父文件夹的旧记录时去掉前缀。
 * 必须在事务内调用。
 */
import type { Db } from '../../db/connection.ts';

/** 子文件夹并进父文件夹：childWins 时同一个目录两边都有合集留子文件夹的，否则留父文件夹的 */
export function mergeChildCollections(db: Db, p: { parent: number; child: number; prefix: string }, childWins: boolean): void {
  const expr = `CASE WHEN rel_dir = '' THEN @prefix ELSE @prefix || '/' || rel_dir END`;
  if (childWins) db.prepare(`DELETE FROM collections WHERE root_id = @parent AND rel_dir IN (SELECT ${expr} FROM collections WHERE root_id = @child)`).run(p);
  else db.prepare(`DELETE FROM collections WHERE root_id = @child AND ${expr} IN (SELECT rel_dir FROM collections WHERE root_id = @parent)`).run(p);
  db.prepare(`UPDATE collections SET root_id = @parent, rel_dir = ${expr} WHERE root_id = @child`).run(p);
}

/**
 * 接管移除过的父文件夹在这个子文件夹下的合集（去掉前缀），连同正好在这个子文件夹上的那本（单独加回一本书的文件夹：新文件夹里它在 ''）。
 * 同一个目录新文件夹里已经有合集的不接管
 */
export function adoptCollections(db: Db, p: { root: number; from: number; prefix: string }): void {
  const rest = `CASE WHEN rel_dir = @prefix THEN '' ELSE substr(rel_dir, length(@prefix) + 2) END`;
  db.prepare(
    `UPDATE collections SET root_id = @root, rel_dir = ${rest}
     WHERE root_id = @from AND (rel_dir = @prefix OR substr(rel_dir, 1, length(@prefix) + 1) = @prefix || '/')
       AND ${rest} NOT IN (SELECT rel_dir FROM collections WHERE root_id = @root)`,
  ).run(p);
}

/**
 * 启动时真正删掉移除超过保留期的文件夹之前：跨文件夹选的合集（不是按文件夹成册的）原来挂靠在这个文件夹上的，
 * 换挂到还在的文件夹里的第一张成员所在的文件夹，免得跟着级联删掉
 */
export function reanchorSelections(db: Db, cutoff: string): void {
  db.prepare(`UPDATE collections SET root_id = (SELECT i.root_id FROM images i JOIN library_roots r ON r.id = i.root_id
      WHERE i.collection_id = collections.id AND r.removed_at IS NULL ORDER BY i.id LIMIT 1)
    WHERE membership <> 'folder' AND root_id IN (SELECT id FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?)
      AND EXISTS (SELECT 1 FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.collection_id = collections.id AND r.removed_at IS NULL)`).run(cutoff);
}
