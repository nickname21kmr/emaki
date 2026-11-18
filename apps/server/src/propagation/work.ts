/**
 * 排队状态的持久化（pending_work 表，迁移 033）：要交给后台任务、还没做完的工作，以及用户的暂停，重启不丢（第 7 节）。
 * - 'dedupe'：可见性或文件内容变了，要重新查重；查重跑完（没被取消）清掉开始之前的标记。
 * - 'collections'：后台任务、启动修补把合集的全量重算延后了（defer），还没做（P4a）；做完清掉。进程中途退出时下次启动补做。
 * - 'pause:<任务>'：用户取消了识别、画师补跑、Pixiv 补充，之后不再自动续跑，直到用户手动开始（P4a，以前只在内存里，重启就丢）。
 * 待识别（tagged_at / retag）、Pixiv 待检查（pixiv_character_checks）本来就持久化在各自的行里，不在这里。
 */
import type { JobKind } from '@emaki/shared';
import type { Db } from '../db/connection.ts';

export type PausableJob = Extract<JobKind, 'tag' | 'artists' | 'pixiv-tags'>;
export type WorkKind = 'dedupe' | 'collections' | `pause:${PausableJob}`;

/** 标记要做（已有标记时更新时间） */
export function markWork(db: Db, kind: WorkKind, at: string): void {
  db.prepare(
    `INSERT INTO pending_work (kind, requested_at) VALUES (?, ?)
     ON CONFLICT(kind) DO UPDATE SET requested_at = MAX(requested_at, excluded.requested_at)`,
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

/** 用户暂停 / 恢复某个任务的自动续跑 */
export function setPaused(db: Db, job: PausableJob, paused: boolean, at: string): void {
  if (paused) markWork(db, `pause:${job}`, at);
  else db.prepare('DELETE FROM pending_work WHERE kind = ?').run(`pause:${job}`);
}

export function isPaused(db: Db, job: PausableJob): boolean {
  return hasWork(db, `pause:${job}`);
}
