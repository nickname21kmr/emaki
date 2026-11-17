/**
 * 变更传播（docs/core-architecture.md 第 5 节）：变化集 + 反应注册表 + 三个阶段。
 *
 * 写操作在 run()（ctx.mutate / ctx.apply 都走这里）里执行，用 changed() 声明「改了什么」；之后：
 * - 事务内（tx）：同一个事务里按注册顺序跑订阅了这些变化的反应。反应必须是幂等的重算（从事实重新算出结果）；
 *   反应自己声明的变化继续处理，直到没有新变化。超过 MAX_ROUNDS 轮还没停下就报错（整个事务回滚）。
 * - 提交后：先跑排队（queue：把工作交给后台任务，排队状态在库里），再跑提交后反应（after：刷新缓存、推事件、通知监听者）。
 *   这两个阶段出错只记日志：数据已经提交了。
 *
 * 后台任务、启动修补这类非交互的 actor，可以把昂贵的全量重算延后（defer），任务结束时（jobFinished）或启动完成时一次做完。
 * 撤销 = 按撤销记录还原事实 + 把原操作声明的变化重放一遍（replay），反应都是重算，所以派生数据自然对。
 */
import type { JobKind } from '@emaki/shared';
import type { SqliteContext } from '../datasource/sqlite/context.ts';
import type { UndoRecorder } from '../datasource/sqlite/undo.ts';
import { currentActor, jobActor, runAs, type Actor } from './actor.ts';
import { ChangeSet, type Change, type ChangeType } from './changes.ts';

export type Phase = 'tx' | 'queue' | 'after';

/** 事务内反应最多跑几轮（每轮按注册顺序把所有反应过一遍） */
export const MAX_ROUNDS = 8;

export interface ReactionInput {
  readonly ctx: SqliteContext;
  /** 这次要处理的变化（只含订阅了的类型） */
  readonly changes: ChangeSet;
  /** 这个事务到现在为止的全部变化 */
  readonly all: ChangeSet;
  readonly actor: Actor;
  /**
   * 事务内反应：当前操作的撤销记录。不可撤销的写入、撤销重放时是 null。
   * 反应删掉了重算不出来的东西（比如过期的证据）时记在这里，撤销时还原
   */
  readonly undo: UndoRecorder | null;
  /** 事务内反应：声明自己引起的变化（会继续传播） */
  emit(c: Change): void;
  /** 把昂贵的全量重算延后：任务结束、启动完成时做一次（key 相同的只做一次） */
  defer(key: string): void;
}

export interface Reaction {
  readonly name: string;
  /** 订阅的变化 */
  readonly on: readonly ChangeType[];
  readonly phase: Phase;
  /** 会声明的变化（检查有没有循环用）；只对事务内反应有意义 */
  readonly emits?: readonly ChangeType[];
  /** 提交后反应：没有任何变化（例如只改了画师合并关系）也执行 */
  readonly always?: boolean;
  run(input: ReactionInput): void | Promise<unknown>;
}

interface Frame {
  set: ChangeSet;
  actor: Actor;
  undo: UndoRecorder | null;
}

export class Propagation {
  private readonly reactions: Reaction[] = [];
  private readonly deferredHandlers = new Map<string, (actor: Actor) => void>();
  private readonly deferred = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private frame: Frame | null = null;
  private readonly finishedListeners: ((kind: JobKind) => void)[] = [];

  constructor(private readonly getCtx: () => SqliteContext) {}

  private get ctx(): SqliteContext {
    return this.getCtx();
  }

  /** 注册反应；同一阶段按注册顺序执行 */
  register(...rs: Reaction[]): void {
    for (const r of rs) {
      if (this.reactions.some((x) => x.name === r.name)) throw new Error(`反应 ${r.name} 注册了两次`);
      this.reactions.push(r);
    }
  }

  /** 已注册的反应（测试、文档用） */
  list(): readonly Reaction[] {
    return this.reactions;
  }

  /** 延后的全量重算：key → 怎么做（在 run 里执行，可以声明变化） */
  onDeferred(key: string, handler: (actor: Actor) => void): void {
    this.deferredHandlers.set(key, handler);
  }

  /** 后台任务结束时（不论完成、让出、取消、失败）通知：core/jobs.ts 调 jobFinished */
  onJobFinished(fn: (kind: JobKind) => void): void {
    this.finishedListeners.push(fn);
  }

  /** 正在 run 里（有一个变化集在收集） */
  get active(): boolean {
    return this.frame !== null;
  }

  /** 声明一条变化。只能在 run（ctx.mutate / ctx.apply）里调用 */
  changed(c: Change): void {
    if (!this.frame) throw new Error(`变化「${c.type}」只能在 ctx.mutate / ctx.apply 里声明`);
    this.frame.set.add(c);
  }

  /**
   * 在一个事务里执行 fn，fn 里用 changed() 声明变化；提交前跑事务内反应，提交后跑排队和提交后反应。
   * 已经在 run 里时（嵌套调用）并进外层：外层结束时一起处理。
   * replay：撤销时重放原操作声明的变化。返回 fn 的结果和 fn 自己声明的变化（不含反应声明的）
   */
  run<T>(fn: () => T, opts: { actor?: Actor; undo?: UndoRecorder | null; replay?: readonly Change[] } = {}): { value: T; declared: Change[] } {
    const outer = this.frame;
    if (outer) {
      const from = outer.set.size;
      for (const c of opts.replay ?? []) outer.set.add(c);
      const value = fn();
      return { value, declared: outer.set.list.slice(from) };
    }
    const frame: Frame = { set: new ChangeSet(), actor: opts.actor ?? currentActor(), undo: opts.undo ?? null };
    this.frame = frame;
    let declared: Change[] = [];
    let value: T;
    try {
      value = this.ctx.db.transaction(() => {
        for (const c of opts.replay ?? []) frame.set.add(c);
        const v = fn();
        declared = [...frame.set.list];
        this.runTx(frame);
        return v;
      })();
    } finally {
      this.frame = null;
    }
    this.afterCommit(frame);
    return { value, declared };
  }

  private input(frame: Frame, changes: ChangeSet): ReactionInput {
    return {
      ctx: this.ctx,
      changes,
      all: frame.set,
      actor: frame.actor,
      undo: frame.undo,
      emit: (c) => frame.set.add(c),
      defer: (key) => {
        if (!this.deferredHandlers.has(key)) throw new Error(`没有登记延后处理 ${key}`);
        this.deferred.add(key);
      },
    };
  }

  private runTx(frame: Frame): void {
    const tx = this.reactions.filter((r) => r.phase === 'tx');
    const seen = new Map<Reaction, number>();
    const unseen = (r: Reaction) => frame.set.list.slice(seen.get(r) ?? 0).filter((c) => r.on.includes(c.type));
    for (let round = 1; ; round++) {
      let ran = false;
      for (const r of tx) {
        const mine = unseen(r);
        seen.set(r, frame.set.size);
        if (!mine.length) continue;
        ran = true;
        r.run(this.input(frame, new ChangeSet(mine)));
      }
      if (!ran) return;
      if (round >= MAX_ROUNDS) {
        const left = tx.filter((r) => unseen(r).length).map((r) => r.name);
        if (left.length) throw new Error(`变更传播跑了 ${MAX_ROUNDS} 轮还没停下（反应之间可能有循环）：${left.join('、')}`);
        return;
      }
    }
  }

  private afterCommit(frame: Frame): void {
    for (const phase of ['queue', 'after'] as const) {
      for (const r of this.reactions) {
        if (r.phase !== phase) continue;
        const mine = new ChangeSet(frame.set.list.filter((c) => r.on.includes(c.type)));
        if (!mine.size && !r.always) continue;
        try {
          const out = r.run(this.input(frame, mine));
          if (out instanceof Promise) this.track(out, r.name);
        } catch (err) {
          console.warn(`[变更传播] 提交后的反应 ${r.name} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private track(p: Promise<unknown>, name: string): void {
    const tracked = p.catch((err: unknown) => console.warn(`[变更传播] 反应 ${name} 失败：${err instanceof Error ? err.message : String(err)}`));
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** 等提交后反应里还在跑的异步工作（例如切换识别方式后从缓存重新匹配 Pixiv）做完 */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** 把延后的全量重算做掉（以 actor 的身份，一个事务；没有延后的就什么也不做） */
  flushDeferred(actor: Actor): void {
    if (!this.deferred.size) return;
    const keys = [...this.deferred];
    this.deferred.clear();
    runAs(actor, () =>
      this.run(() => {
        for (const k of keys) this.deferredHandlers.get(k)!(actor);
      }),
    );
  }

  /** 撤回已经登记的延后处理（例如提交后反应已经做了一次全量） */
  cancelDeferred(key: string): void {
    this.deferred.delete(key);
  }

  /** 后台任务结束（完成、让出、取消、失败都算）：做掉延后的全量重算，再通知监听者（推事件） */
  jobFinished(kind: JobKind): void {
    try {
      this.flushDeferred(jobActor(kind));
    } catch (err) {
      console.warn(`[变更传播] ${kind} 结束后的重算失败：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const fn of this.finishedListeners) fn(kind);
  }
}
