/**
 * 审计记录和 operationId 幂等（command_log，迁移 040；docs/core-architecture.md 第 4.1、9 节）。只有命令层写这张表。
 *
 * - 每次执行写命令记一行：命令名、actor、结果那句话、撤销令牌、变了哪些事实。在「谁改的」这件事上，网页是 user，助手是 assistant，
 *   后台任务是 job:<任务>（每跑完一轮一行），启动修补不记（它只按规则重算派生数据）。
 * - 带 operationId 的按 operation_key 去重，结果整份存下，重试时原样返回。
 * - 启动时把上次没做完的（running）标成 interrupted，只留最近 KEEP 行。
 */
import type { DomainChange } from '@emaki/shared';
import { createHash } from 'node:crypto';
import type { SqliteContext } from '../datasource/sqlite/context.ts';

/** 只留最近这么多行（10 万张图的库一天也就几百条命令） */
export const AUDIT_KEEP = 20_000;

export interface AuditRow {
  id: number;
  at: string;
  command: string;
  actor: string;
  operation_key: string | null;
  signature: string | null;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  message: string | null;
  undo_token: string | null;
  changes: string | null;
  result: string | null;
  error: string | null;
}

export interface AuditOutcome {
  status: 'done' | 'failed';
  message?: string | null;
  undoToken?: string | null;
  changes?: readonly DomainChange[];
  /** 带 operationId 的才存 */
  result?: unknown;
  error?: string;
}

/** 输入的签名：同一个 operationId 换了参数就是冲突 */
export function signatureOf(command: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([command, input]))
    .digest('hex');
}

export class Audit {
  constructor(private readonly ctx: SqliteContext) {}

  private now(): string {
    return new Date(this.ctx.clock()).toISOString();
  }

  /** 这个撤销令牌是谁的操作给出的（没记录是 null）。手机只能撤销自己的操作（commands/system.ts 的 history.undo） */
  actorOfUndoToken(token: string): string | null {
    const row = this.ctx.db.prepare('SELECT actor FROM command_log WHERE undo_token = ? ORDER BY id DESC LIMIT 1').get(token) as
      | { actor: string }
      | undefined;
    return row?.actor ?? null;
  }

  /** 启动时：上次进程中途退出、没做完的标成 interrupted（结果不确定）；只留最近 AUDIT_KEEP 行 */
  open(): void {
    const db = this.ctx.db;
    db.prepare("UPDATE command_log SET status = 'interrupted' WHERE status = 'running'").run();
    db.prepare('DELETE FROM command_log WHERE id <= (SELECT id FROM command_log ORDER BY id DESC LIMIT 1 OFFSET ?)').run(AUDIT_KEEP);
  }

  /** 带 operationId 的命令先占一行（running） */
  begin(e: { command: string; actor: string; key: string | null; signature: string | null }): number {
    return Number(
      this.ctx
        .stmt(`INSERT INTO command_log (at, command, actor, operation_key, signature, status) VALUES (?, ?, ?, ?, ?, 'running')`)
        .run(this.now(), e.command, e.actor, e.key, e.signature).lastInsertRowid,
    );
  }

  /** 做完（成功或失败）：写结果 */
  finish(id: number, o: AuditOutcome): void {
    this.ctx
      .stmt('UPDATE command_log SET status = ?, message = ?, undo_token = ?, changes = ?, result = ?, error = ? WHERE id = ?')
      .run(
        o.status,
        o.message ?? null,
        o.undoToken ?? null,
        o.changes?.length ? JSON.stringify(o.changes) : null,
        o.result === undefined ? null : JSON.stringify(o.result),
        o.error ?? null,
        id,
      );
  }

  /** 没带 operationId 的命令、后台任务：做完一次写一行 */
  record(e: { command: string; actor: string }, o: AuditOutcome): void {
    this.ctx
      .stmt(`INSERT INTO command_log (at, command, actor, status, message, undo_token, changes, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        this.now(),
        e.command,
        e.actor,
        o.status,
        o.message ?? null,
        o.undoToken ?? null,
        o.changes?.length ? JSON.stringify(o.changes) : null,
        o.error ?? null,
      );
  }

  byKey(key: string): AuditRow | undefined {
    return this.ctx.stmt('SELECT * FROM command_log WHERE operation_key = ?').get(key) as AuditRow | undefined;
  }

  /** 失败过的那次让出 operation_key，同一个 operationId 可以重试（命令失败时什么都没改） */
  release(id: number): void {
    this.ctx.stmt('UPDATE command_log SET operation_key = NULL WHERE id = ?').run(id);
  }

  list(q: { limit?: number; actor?: string; command?: string; before?: number }): AuditRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.actor) (where.push('actor = ?'), args.push(q.actor));
    if (q.command) (where.push('command = ?'), args.push(q.command));
    if (q.before !== undefined) (where.push('id < ?'), args.push(q.before));
    return this.ctx.db
      .prepare(`SELECT * FROM command_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, q.limit ?? 50) as AuditRow[];
  }
}
