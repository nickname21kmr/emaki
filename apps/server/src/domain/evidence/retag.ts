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

/**
 * 文件内容变了（D1，扫描发现和用户替换一样）：这份文件版本还没有识别结果——识别时间、模型清空，识别任务会重新挑它；
 * 画师识别也重来（artist_checked_at 清空）。标签、角色候选这些旧证据先留着（标成过期：识别时间为空），新证据到了整体替换，
 * 依据旧证据的自动关联那时由 reevaluateAuto 按 D2 处理。u 不为空时记撤销
 */
export function markFileEvidenceStale(db: Db, u: UndoRecorder | null, ids: number[]): void {
  if (!ids.length) return;
  u?.columns('images', ['tagged_at', 'tagger_model', 'artist_checked_at'], ids);
  stmt(db, 'UPDATE images SET tagged_at = NULL, tagger_model = NULL, artist_checked_at = NULL WHERE id IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(ids),
  );
}
