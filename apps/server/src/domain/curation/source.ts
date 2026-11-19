/**
 * 手动确认的来源（images.source_manual，归类的决定）：设了之后，按路径重新解析不再改它（reparseSource、改识别方式只动没确认过的）。
 * 来源的值还和解析出的来源同列（P4 拆开），由证据模块写（domain/evidence/source.ts）。
 */
import type { ImageSource } from '@emaki/shared';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { copySource, writeSource } from '../evidence/source.ts';
import { stmt, type DomainTx } from '../tx.ts';

/** 用户确认 / 清除来源（manual = true），或恢复自动（manual = false，src 是按路径重新解析的） */
export function setManualSource(tx: DomainTx, u: UndoRecorder | null, id: number, src: ImageSource | null, manual: boolean): void {
  u?.columns('images', ['source_manual'], [id]);
  writeSource(tx.db, u, id, src);
  stmt(tx.db, 'UPDATE images SET source_manual = ? WHERE id = ?').run(manual ? 1 : 0, id);
}

/**
 * 查重合并（附录 #12）：副本里第一张手动确认过来源的（有链接的优先于手动清空的）照搬到保留的图上；
 * 保留的图自己确认过的不动，自动解析出来的可以被盖掉。返回改了的图（调用方比较前后的来源，变了的声明 image.sourceChanged）
 */
export function carrySource(tx: DomainTx, u: UndoRecorder | null, keep: number[], gone: number[]): number[] {
  const db = tx.db;
  const src = stmt(db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND source_manual = 1 ORDER BY source_url IS NULL, id LIMIT 1')
    .pluck()
    .get(JSON.stringify(gone)) as number | undefined;
  if (src === undefined) return [];
  const targets = stmt(db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL AND source_manual = 0')
    .pluck()
    .all(JSON.stringify(keep)) as number[];
  if (!targets.length) return [];
  u?.columns('images', ['source_manual'], targets);
  copySource(db, u, targets, src);
  stmt(db, 'UPDATE images SET source_manual = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(targets));
  return targets;
}
