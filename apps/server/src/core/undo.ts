import { randomUUID } from 'node:crypto';
import type { MutationResult, UndoTokenStatus } from '@emaki/shared';
import { HttpError, NotFoundError } from '../http/errors.ts';

interface UndoEntry {
  label: string;
  revert: () => Promise<void> | void;
}

/**
 * 服务端撤销栈。每个可撤销的修改都 push 一个「反向操作」，返回 token 给前端。
 * 只保留最近 MAX 条；进程重启后清空（撤销只是便利功能，不需要持久化）。
 */
export class UndoStack {
  private static readonly MAX = 50;
  private readonly entries = new Map<string, UndoEntry>();
  // 撤销过 / 被挤掉的 token，只留最近 SETTLED_MAX 条；更早的和重启前的都按 expired 算
  private static readonly SETTLED_MAX = 1000;
  private readonly settled = new Map<string, 'undone' | 'expired'>();
  // 主动作废的 token 再撤销时报的话（例如已经放进系统回收站）
  private readonly reasons = new Map<string, string>();

  private settle(token: string, state: 'undone' | 'expired') {
    this.settled.delete(token);
    this.settled.set(token, state);
    while (this.settled.size > UndoStack.SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
      this.reasons.delete(oldest);
    }
  }

  /** 让还没撤销的 token 作废，之后撤销它报 reason。不认识或已经撤销的不动 */
  expire(token: string, reason?: string): void {
    if (!this.entries.delete(token)) return;
    if (reason) this.reasons.set(token, reason);
    this.settle(token, 'expired');
  }

  push(label: string, revert: UndoEntry['revert']): string {
    const token = randomUUID();
    this.entries.set(token, { label, revert });
    while (this.entries.size > UndoStack.MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.settle(oldest, 'expired');
    }
    return token;
  }

  /** 生成一个带撤销的 MutationResult。 */
  result(message: string, revert: UndoEntry['revert']): MutationResult {
    return { ok: true, message, undoToken: this.push(message, revert) };
  }

  /** 这个 token 现在的状态；不认识的（例如后端重启前发的）算 expired */
  status(token: string): UndoTokenStatus {
    return this.entries.has(token) ? 'live' : (this.settled.get(token) ?? 'expired');
  }

  async run(token: string): Promise<MutationResult> {
    const entry = this.entries.get(token);
    if (!entry) {
      const reason = this.reasons.get(token);
      throw reason ? new HttpError(404, 'not_found', reason) : new NotFoundError('可撤销的操作（可能已过期）');
    }
    this.entries.delete(token);
    try {
      await entry.revert();
    } catch (err) {
      // 已经拿出栈了，再点也撤不了
      this.settle(token, 'expired');
      throw err;
    }
    this.settle(token, 'undone');
    return { ok: true, message: `已撤销：${entry.label}`, undoToken: null };
  }
}

/** 移到回收站先只在库里标记，最近这么多次还能撤销；再多就把最早的真的放进系统回收站 */
export const TRASH_UNDO_WINDOW = 5;
/** 挤出窗口的那次再撤销时的提示 */
export const TRASH_COMMITTED = '这一步已经放进系统回收站，撤销不了';

/** 不可撤销的操作用这个。 */
export function done(message: string): MutationResult {
  return { ok: true, message, undoToken: null };
}
