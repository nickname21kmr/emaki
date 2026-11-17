/**
 * 画师的手动合并 / 拆开（artist_links，编目的表）。怎么算出要改哪些标签在 datasource/sqlite/artists.ts。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';

/**
 * 可撤销地改画师的合并关系（调用方在 ctx.mutate 里）：先去掉这些标签原来的设置；
 * merge 写成并到 into，split 写成各自独立（group_tag 为空），auto 就是恢复自动合并（不再写）
 */
export function setArtistLinks(db: Db, u: UndoRecorder, mode: 'merge' | 'split' | 'auto', tags: string[], into: string | null, now: string): void {
  const json = JSON.stringify(tags);
  u.set('artist_links', 'tag IN (SELECT value FROM json_each(?))', [json]);
  db.prepare('DELETE FROM artist_links WHERE tag IN (SELECT value FROM json_each(?))').run(json);
  if (mode === 'auto') return;
  const ins = db.prepare('INSERT INTO artist_links (tag, group_tag, created_at) VALUES (?, ?, ?)');
  for (const t of tags) ins.run(t, into, now);
}
