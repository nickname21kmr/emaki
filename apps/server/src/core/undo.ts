import { randomUUID } from 'node:crypto';
import type { MutationResult } from '@emaki/shared';
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

  push(label: string, revert: UndoEntry['revert']): string {
    const token = randomUUID();
    this.entries.set(token, { label, revert });
    while (this.entries.size > UndoStack.MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return token;
  }

  /** 生成一个带撤销的 MutationResult。 */
  result(message: string, revert: UndoEntry['revert']): MutationResult {
    return { ok: true, message, undoToken: this.push(message, revert) };
  }

  async run(token: string): Promise<MutationResult> {
    const entry = this.entries.get(token);
    if (!entry) throw new NotFoundError('可撤销的操作（可能已过期）');
    this.entries.delete(token);
    await entry.revert();
    return { ok: true, message: `已撤销：${entry.label}`, undoToken: null };
  }
}

/** 不可撤销的操作用这个。 */
export function done(message: string): MutationResult {
  return { ok: true, message, undoToken: null };
}
