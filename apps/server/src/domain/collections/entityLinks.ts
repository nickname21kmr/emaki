/**
 * 合集的整本关联（collection_characters / collection_works，T38b）在编目合并角色、作品时跟着搬。
 * 编目模块不直接写合集的表，调这里（docs/core-architecture.md 第 2.4 节）。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';

/**
 * 合并角色：被合并角色的整本关联搬给目标（目标已有的不重复）。被合并角色自己的行随角色删除级联删掉。
 * 撤销记录必须在 characters 之前记（撤销时 characters 先插回，外键才不失败）：调用方按这个顺序调用
 */
export function carryCollectionCharacters(db: Db, u: UndoRecorder, from: number, to: number): void {
  const moved = JSON.stringify(
    db
      .prepare(
        `SELECT collection_id FROM collection_characters WHERE character_id = @from
           AND collection_id NOT IN (SELECT collection_id FROM collection_characters WHERE character_id = @to)`,
      )
      .pluck()
      .all({ from, to }),
  );
  u.sql('DELETE FROM collection_characters WHERE character_id = ? AND collection_id IN (SELECT value FROM json_each(?))', [to, moved]);
  u.set('collection_characters', 'character_id = ?', [from]);
  db.prepare(
    `INSERT OR IGNORE INTO collection_characters (collection_id, character_id, added_at)
     SELECT collection_id, @to, added_at FROM collection_characters WHERE character_id = @from`,
  ).run({ from, to });
}

/** 收拢改过名的作品（启动修补，不可撤销）：旧作品的整本关联搬给新作品。旧作品的行随作品删除级联删掉 */
export function carryCollectionWorks(db: Db, from: number, to: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO collection_works (collection_id, work_id, added_at)
     SELECT collection_id, @to, added_at FROM collection_works WHERE work_id = @from`,
  ).run({ from, to });
}
