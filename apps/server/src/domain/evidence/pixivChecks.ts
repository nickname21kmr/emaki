import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';

/** 用户实际移除角色后，不把其余旧建议在补跑时重新采纳；撤销操作同时恢复这个状态。 */
export function dismissPixivCharacterChecks(db: Db, undo: UndoRecorder | null, ids: number[], now: string): void {
  if (!ids.length) return;
  const images = db.prepare(`SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?))
    AND source_site='pixiv' AND source_post_id IS NOT NULL`).pluck().all(JSON.stringify(ids)) as number[];
  if (!images.length) return;
  const json = JSON.stringify(images);
  undo?.set('pixiv_character_checks', 'image_id IN (SELECT value FROM json_each(?))', [json]);
  db.prepare(`INSERT INTO pixiv_character_checks(image_id,post_id,sha256,checked_at,result)
    SELECT id,source_post_id,sha256,?,'dismissed' FROM images WHERE id IN (SELECT value FROM json_each(?))
    ON CONFLICT(image_id) DO UPDATE SET post_id=excluded.post_id,sha256=excluded.sha256,
      checked_at=excluded.checked_at,result=excluded.result`).run(now,json);
}
