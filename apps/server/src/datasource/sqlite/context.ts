import type { EventBus } from '../../core/events.ts';
import type { JobQueue } from '../../core/jobs.ts';
import type { MutationResult } from '@emaki/shared';
import { done, type UndoStack } from '../../core/undo.ts';
import type { Db, Statement } from '../../db/connection.ts';
import { UndoRecorder } from './undo.ts';

/**
 * SQLite 数据源的共享上下文。各个查询 / 服务模块都拿它，而不是自己 new Database。
 * T22 会加 emitChanged()。
 */
export interface SqliteContext {
  readonly db: Db;
  readonly bus: EventBus;
  readonly dataDir: string;
  /** 测试可以注入固定时间 */
  readonly clock: () => number;
  readonly undo: UndoStack;
  readonly jobs: JobQueue;
  /** 数据变了：让派生缓存失效（T13/T22 往里挂具体的缓存） */
  invalidate(scope?: 'all' | 'stats' | 'entities', opts?: { soft?: boolean }): void;
  /** 用户操作之后：invalidate + emit { type: 'library-changed', reason: 'mutation' } */
  touch(): void;
  /** 预编译语句缓存：同一段 SQL 只 prepare 一次 */
  stmt(sql: string): Statement;
  /** 所有可撤销修改的唯一入口：一个事务 + 自动收集撤销数据。fn 必须是同步函数 */
  mutate<T extends { message: string }>(fn: (u: UndoRecorder) => T): MutationResult & Omit<T, 'message'>;
  /** 不可撤销的修改 */
  write(fn: () => string): MutationResult;
}

export type InvalidateListener = (scope: 'all' | 'stats' | 'entities', opts: { soft?: boolean }) => void;

export function createContext(init: {
  db: Db;
  bus: EventBus;
  dataDir: string;
  clock: () => number;
  undo: UndoStack;
  jobs: JobQueue;
}): SqliteContext & { onInvalidate(listener: InvalidateListener): void } {
  const statements = new Map<string, Statement>();
  const listeners: InvalidateListener[] = [];
  const ctx = {
    ...init,
    invalidate(scope: 'all' | 'stats' | 'entities' = 'all', opts: { soft?: boolean } = {}) {
      for (const l of listeners) l(scope, opts);
    },
    touch() {
      ctx.invalidate('all');
      init.bus.emit({ type: 'library-changed', reason: 'mutation' });
    },
    stmt(sql: string): Statement {
      let s = statements.get(sql);
      if (!s) {
        s = init.db.prepare(sql);
        statements.set(sql, s);
      }
      return s;
    },
    mutate<T extends { message: string }>(fn: (u: UndoRecorder) => T): MutationResult & Omit<T, 'message'> {
      const u = new UndoRecorder(init.db);
      const out = init.db.transaction(() => fn(u))();
      ctx.touch();
      const { message, ...rest } = out;
      if (u.isEmpty) return { ...rest, ...done(message) };
      const revert = u.build();
      return {
        ...rest,
        ...init.undo.result(message, async () => {
          await revert();
          ctx.touch();
        }),
      };
    },
    write(fn: () => string): MutationResult {
      const msg = init.db.transaction(fn)();
      ctx.touch();
      return done(msg);
    },
    onInvalidate(listener: InvalidateListener) {
      listeners.push(listener);
    },
  };
  return ctx;
}
