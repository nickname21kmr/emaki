/**
 * 手动类型的标记（images.content_kind_manual，归类的决定）：设了就是用户定的类型，自动判断永远不覆盖。
 * 类型本身（content_kind 等）现在还和自动判断同列（分析模块的列，P4 拆开），由调用方（datasource/sqlite/kinds.ts）写。
 */
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { stmt, type DomainTx } from '../tx.ts';

export function setKindManual(tx: DomainTx, u: UndoRecorder | null, ids: number[], manual: boolean): void {
  if (!ids.length) return;
  u?.columns('images', ['content_kind_manual'], ids);
  stmt(tx.db, 'UPDATE images SET content_kind_manual = ? WHERE id IN (SELECT value FROM json_each(?))').run(manual ? 1 : 0, JSON.stringify(ids));
}
