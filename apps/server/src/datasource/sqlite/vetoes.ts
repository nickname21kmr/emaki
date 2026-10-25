import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from './undo.ts';

/**
 * 用户从图上去掉角色时记一笔「不要」：之后重新识别、采纳建议、Pixiv 补充都跳过这一对，也不再作为建议。
 * 在 mutate 里、删除 image_characters 之前调用（只记现在确实挂着的）；撤销时删掉这次新记的。
 */
export function vetoRemovedCharacter(db: Db, u: UndoRecorder, characterId: number, imageIds: number[], now: string): void {
  if (!imageIds.length) return;
  const ids = db
    .prepare(
      `SELECT image_id FROM image_characters WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))
       AND image_id NOT IN (SELECT image_id FROM character_vetoes WHERE character_id = ?)`,
    )
    .pluck()
    .all(characterId, JSON.stringify(imageIds), characterId) as number[];
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  u.sql('DELETE FROM character_vetoes WHERE character_id = ? AND image_id IN (SELECT value FROM json_each(?))', [characterId, json]);
  db.prepare('INSERT INTO character_vetoes (image_id, character_id, created_at) SELECT value, ?, ? FROM json_each(?)').run(characterId, now, json);
}

/** 这张图上的这个角色被用户去掉过 */
export function vetoChecker(db: Db): (imageId: number, characterId: number) => boolean {
  const st = db.prepare('SELECT 1 FROM character_vetoes WHERE image_id = ? AND character_id = ?').pluck();
  return (imageId, characterId) => st.get(imageId, characterId) !== undefined;
}
