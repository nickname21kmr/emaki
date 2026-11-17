/**
 * 排队状态的持久化（pending_work 表，迁移 033）：要交给后台任务、还没做完的工作，重启不丢。
 * 现在只有查重（'dedupe'）：可见性或文件内容变了就标记，查重跑完（没被取消）清掉开始之前的标记。
 * 识别、Pixiv 补充本来就持久化在图片行和 pixiv_character_checks 里，不在这里。
 */
import type { Db } from '../db/connection.ts';

export type WorkKind = 'dedupe';

/** 标记要做（已有标记时更新时间） */
export function markWork(db: Db, kind: WorkKind, at: string): void {
  db.prepare(
    'INSERT INTO pending_work (kind, requested_at) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET requested_at = MAX(requested_at, excluded.requested_at)',
  ).run(kind, at);
}

export function hasWork(db: Db, kind: WorkKind): boolean {
  return !!db.prepare('SELECT 1 FROM pending_work WHERE kind = ?').get(kind);
}

/** 现在的标记时间（没有标记是 null）：任务开始时记下，做完交给 clearWork */
export function peekWork(db: Db, kind: WorkKind): string | null {
  return (db.prepare('SELECT requested_at FROM pending_work WHERE kind = ?').pluck().get(kind) as string | undefined) ?? null;
}

/** 做完了：清掉开始时看到的那个标记（seen 之前、含）；任务开始之后又标记的留着，下次再做 */
export function clearWork(db: Db, kind: WorkKind, seen: string | null): void {
  if (seen === null) return;
  db.prepare('DELETE FROM pending_work WHERE kind = ? AND requested_at <= ?').run(kind, seen);
}
