import { randomUUID } from 'node:crypto';
import type { MutationResult, UndoTokenStatus } from '@emaki/shared';
import { NotFoundError } from '../http/errors.ts';

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

  private settle(token: string, state: 'undone' | 'expired') {
    this.settled.delete(token);
    this.settled.set(token, state);
    while (this.settled.size > UndoStack.SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
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
    if (!entry) throw new NotFoundError('可撤销的操作（可能已过期）');
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

/** 不可撤销的操作用这个。 */
export function done(message: string): MutationResult {
  return { ok: true, message, undoToken: null };
}
