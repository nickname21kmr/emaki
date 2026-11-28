import type { EventBus } from '../../core/events.ts';
import type { JobQueue } from '../../core/jobs.ts';
import type { MutationResult } from '@emaki/shared';
import { done, type UndoStack } from '../../core/undo.ts';
import type { Db, Statement } from '../../db/connection.ts';
import type { Actor } from '../../propagation/actor.ts';
import { EVERYTHING_SCOPE, type CacheScope } from '../../propagation/cacheScope.ts';
import type { Change } from '../../propagation/changes.ts';
import { Propagation } from '../../propagation/registry.ts';
import { UndoRecorder } from './undo.ts';

/**
 * SQLite 数据源的共享上下文。各个查询 / 服务模块都拿它，而不是自己 new Database。
 *
 * 写操作只走 mutate（可撤销）或 apply（不可撤销），在里面用 changed() 声明「改了什么」；
 * 连带处理（排除结果、合集、Pixiv 排队、查重标记、缓存、事件……）由变更传播的反应完成（propagation/，docs/ARCHITECTURE.md「变更传播」）。
 */
export interface SqliteContext {
  readonly db: Db;
  readonly bus: EventBus;
  readonly dataDir: string;
  /** 测试可以注入固定时间 */
  readonly clock: () => number;
  readonly undo: UndoStack;
  readonly jobs: JobQueue;
  /** 变化集和反应注册表 */
  readonly propagation: Propagation;
  /**
   * 让缓存失效。只由变更传播的提交后反应调用（按 actor 决定强 / 弱，按这次提交声明的变化决定范围，propagation/cacheScope.ts），
   * 其他地方声明变化即可（test/architecture/sideEffects.test.ts 检查）。scope 不给或 'all' = 全部
   */
  invalidate(scope?: 'all' | CacheScope, opts?: { soft?: boolean }): void;
  /** 预编译语句缓存：同一段 SQL 只 prepare 一次 */
  stmt(sql: string): Statement;
  /** 声明一条变化。只能在 mutate / apply 里调用 */
  changed(change: Change): void;
  /**
   * 所有可撤销修改的唯一入口：一个事务 + 自动收集撤销数据 + 变更传播。fn 必须是同步函数。
   * 撤销 = 按撤销记录还原 + 在同一个事务里把这次声明的变化重放一遍（反应重算派生数据）。
   * 命令层（commands/registry.ts）给同步的命令开的就是它；已经在一个 mutate 里时（命令的 tx 里又调了带 mutate 的领域方法、
   * 几个命令合成一次操作）并进外层：同一个事务、同一份撤销记录，令牌由外层发
   */
  mutate<T extends { message: string }>(fn: (u: UndoRecorder) => T): MutationResult & Omit<T, 'message'>;
  /** 不可撤销、但要连带处理的写入（后台任务、启动修补、自带撤销逻辑的文件操作）。fn 必须是同步函数 */
  apply<T>(fn: () => T, opts?: { actor?: Actor }): T;
}

export type InvalidateListener = (scope: CacheScope, opts: { soft?: boolean }) => void;

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
  /** 正在进行的 mutate 的撤销记录（嵌套的 mutate 并进它） */
  let active: UndoRecorder | null = null;
  const ctx: SqliteContext & { onInvalidate(listener: InvalidateListener): void } = {
    ...init,
    propagation: new Propagation(() => ctx),
    invalidate(scope: 'all' | CacheScope = 'all', opts: { soft?: boolean } = {}) {
      const s = scope === 'all' ? EVERYTHING_SCOPE : scope;
      for (const l of listeners) l(s, opts);
    },
    stmt(sql: string): Statement {
      let s = statements.get(sql);
      if (!s) {
        s = init.db.prepare(sql);
        statements.set(sql, s);
      }
      return s;
    },
    changed(change: Change) {
      ctx.propagation.changed(change);
    },
    mutate<T extends { message: string }>(fn: (u: UndoRecorder) => T): MutationResult & Omit<T, 'message'> {
      if (active) {
        const outer = active;
        const { message, ...rest } = ctx.propagation.run(() => fn(outer)).value;
        return { ...rest, ...done(message) };
      }
      const u = new UndoRecorder(init.db);
      active = u;
      let ran: ReturnType<typeof ctx.propagation.run<T>>;
      try {
        ran = ctx.propagation.run(() => fn(u), { undo: u });
      } finally {
        active = null;
      }
      const { value: out, declared } = ran;
      const { message, ...rest } = out;
      if (u.isEmpty) return { ...rest, ...done(message) };
      const restore = u.build();
      return {
        ...rest,
        ...init.undo.result(message, () => {
          ctx.propagation.run(restore, { replay: declared });
        }),
      };
    },
    apply<T>(fn: () => T, opts: { actor?: Actor } = {}): T {
      return ctx.propagation.run(fn, { actor: opts.actor }).value;
    },
    onInvalidate(listener: InvalidateListener) {
      listeners.push(listener);
    },
  };
  return ctx;
}
