/**
 * actor：这次写操作是谁做的（docs/core-architecture.md 第 2.2、5.2 节）。
 * - HTTP 请求默认是 user；AI 助手经 app.inject 调接口时带内部请求头，记成 assistant（只认本进程的令牌，外面的请求伪造不了）；
 * - 后台任务的执行体在 job:<任务种类> 下运行（core/jobs.ts）；启动修补是 system:<步骤>。
 * 提交后的反应按 actor 决定强刷新还是弱刷新：用户和助手强刷新，后台任务和启动修补弱刷新。
 *
 * 用 AsyncLocalStorage 传递：命令、领域模块不用一层层传参。没有设置时（测试直接调方法）按 user 算。
 * 同一份上下文里还带着当前在执行哪个命令（命令层设置，commands/registry.ts）和这期间推出去的事件 id：
 * 提交后反应推的 `changed` 事件记下命令名，命令层据此把事件 id 交给调用方（前端等这个 id 的事件到了再决定要不要自己刷新）。
 */
import type { DomainChange, JobKind, LibraryChangedReason } from '@emaki/shared';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type Actor = 'user' | 'assistant' | `job:${JobKind}` | `system:${string}`;

/** 一次调用的上下文：谁、在执行哪个命令、推出去了哪些事件 */
export interface CallContext {
  readonly actor: Actor;
  /** 命令层正在执行的命令名（commands/registry.ts）；后台任务、启动修补没有 */
  readonly command?: string;
  /** 这次命令期间推出去的公开事件 id（提交后反应写进来） */
  readonly events?: number[];
  /** 这次命令期间变了的事实（公开的类型） */
  readonly changes?: Set<DomainChange>;
}

const storage = new AsyncLocalStorage<CallContext>();

/** 当前的 actor；不在任何上下文里时是 user */
export function currentActor(): Actor {
  return storage.getStore()?.actor ?? 'user';
}

/** 当前的调用上下文（不在任何上下文里时是 undefined） */
export function currentCall(): CallContext | undefined {
  return storage.getStore();
}

/** 以 actor 的身份执行 fn（fn 里的同步代码和之后的异步续体都算这个 actor） */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/** 命令层用：以这个上下文执行一个命令 */
export function runCall<T>(call: CallContext, fn: () => T): T {
  return storage.run(call, fn);
}

/** 用户和助手的操作：界面要马上看到结果，缓存强刷新 */
export const isInteractive = (actor: Actor): boolean => actor === 'user' || actor === 'assistant';

/** 推给前端的 changed 事件的 reason */
export function changedReason(actor: Actor): LibraryChangedReason {
  if (isInteractive(actor)) return 'mutation';
  if (actor.startsWith('job:')) return actor.slice(4) as JobKind;
  return 'system';
}

export const jobActor = (kind: JobKind): Actor => `job:${kind}`;

/** 助手经 app.inject 调接口时带的请求头。值里有本进程启动时生成的令牌，HTTP 进来的请求不知道它 */
export const ACTOR_HEADER = 'x-emaki-actor';
const assistantToken = randomUUID();
export const ASSISTANT_HEADER_VALUE = `assistant ${assistantToken}`;

/** 按请求头认 actor：只有带着本进程令牌的才是 assistant，其余都是 user */
export function actorFromHeaders(headers: Record<string, string | string[] | undefined>): Actor {
  return headers[ACTOR_HEADER] === ASSISTANT_HEADER_VALUE ? 'assistant' : 'user';
}
