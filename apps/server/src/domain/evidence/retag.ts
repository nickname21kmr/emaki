/**
 * 「要重新识别」的标记（images.retag，证据模块的列）：识别任务优先领它，写完清零。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { stmt } from '../tx.ts';

/** 撤销用：记下这些图的标记 */
export function snapshotRetag(u: UndoRecorder, ids: number[]): void {
  u.columns('images', ['retag'], ids);
}

/** 这些图标成要重新识别（已经标过的不动）；返回新标的张数 */
export function markRetag(db: Db, ids: number[]): number {
  if (!ids.length) return 0;
  return stmt(db, 'UPDATE images SET retag = 1 WHERE id IN (SELECT value FROM json_each(?)) AND retag = 0').run(JSON.stringify(ids)).changes;
}

/** 按记下的值写回（撤回移动时） */
export function setRetag(db: Db, rows: { id: number; retag: number }[]): void {
  const upd = stmt(db, 'UPDATE images SET retag = @retag WHERE id = @id');
  for (const r of rows) upd.run(r);
}

/** 漫画区里还挂着自动关联角色的页标成要重新识别（离开漫画区后会重新认）；ids 不给 = 全库。返回标了的张数 */
export function markComicRetag(db: Db, ids?: number[]): number {
  const scope = ids ? 'AND i.id IN (SELECT value FROM json_each(@ids))' : '';
  return stmt(
    db,
    `UPDATE images AS i SET retag = 1
     WHERE i.retag = 0 AND ${IN_COMIC('i')} ${scope}
       AND EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.decision = 'auto')`,
  ).run({ ids: JSON.stringify(ids ?? []) }).changes;
}

/** 文件内容变了（扫描发现）：这张图的识别作废，等重新识别。给扫描器的热循环用的预编译语句（参数 @id） */
export function resetRecognitionStatement(db: Db) {
  return stmt(db, 'UPDATE images SET tagged_at = NULL, tagger_model = NULL WHERE id = @id');
}
