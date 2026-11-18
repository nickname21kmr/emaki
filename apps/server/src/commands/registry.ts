/**
 * 命令 / 查询注册表（docs/core-architecture.md 第 3、4.1、9 节，附录 #33–#36）。
 *
 * 每个操作只定义一次：名字、输入 schema（packages/shared/src/schemas.ts）、权限范围 scope、是否可撤销、是否支持 operationId、执行函数。
 * HTTP 路由（http/routes.ts）和 MCP 工具（assistant/tools.ts）都从这里生成，网页、助手、测试都经这里调用。
 *
 * 命令层统一负责：
 * - 校验输入（schema），记下 actor（AsyncLocalStorage，第 2.2 节）和正在执行的命令；
 * - 事务和撤销记录：同步的命令（tx）由这里开 ctx.mutate，一个命令一个撤销令牌；几个命令可以合成一次操作（batch，一个令牌）。
 *   动文件、跑任务这类异步的命令（run）自己管事务和撤销（它们本来就是「自带撤销逻辑」的）；
 * - operationId 幂等：同一个键再来一次返回存下的结果（commands/audit.ts）；
 * - 审计记录：每次执行记一行，谁、哪个命令、结果、撤销令牌、变了哪些事实；
 * - 撤销屏障：不可撤销的命令在这里声明，结果里给出 undo（token / barrier / none），前端照着放进撤销栈；
 * - 事件：用户、助手的命令执行完推一条 command 事件（AI 助手做的、可撤销的修改，网页据此放进撤销栈）。
 *
 * 执行函数只调用领域模块和读模型（引擎 SqliteDataSource 是装配它们的地方）。
 */
import type { CommandEvent, CommandInfo, DomainChange, ID, Scope, UndoKind } from '@emaki/shared';
import type { z } from 'zod';
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import type { UndoRecorder } from '../datasource/sqlite/undo.ts';
import { BadRequestError, ConflictError, HttpError } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { currentActor, isInteractive, runCall, type Actor } from '../propagation/actor.ts';
import { Audit, signatureOf, type AuditRow } from './audit.ts';

/** 引擎：装配领域模块、读模型、基础设施的地方（不是一个大接口） */
export type Engine = SqliteDataSource;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface HttpBinding {
  method: HttpMethod;
  /** fastify 的路径，参数写成 :id，和输入里的同名字段合并 */
  path: string;
  /** 兼容旧调用者的地址：以后可以删（报告和 GET /api/commands 里列出来） */
  legacy?: boolean;
}

interface Base<I> {
  readonly name: string;
  /** 一句话：GET /api/commands、MCP 工具的说明 */
  readonly summary: string;
  readonly input: z.ZodType<I>;
  readonly scope: Scope;
  readonly http?: readonly HttpBinding[];
  /** MCP 工具：补充给助手的说明；destructive 标出会删改用户东西的（MCP 的 destructiveHint） */
  readonly mcp?: { readonly description?: string; readonly destructive?: boolean };
}

export interface QueryDef<I = any, O = any> extends Base<I> {
  readonly kind: 'query';
  run(e: Engine, input: I): O | Promise<O>;
}

export interface CommandDef<I = any, O = any> extends Base<I> {
  readonly kind: 'command';
  /** 可撤销：返回 undoToken。false 的是撤销屏障（前端在撤销栈里占一格，Ctrl+Z 不越过它） */
  readonly undoable: boolean;
  /** 不可撤销、也不占撤销栈的小动作（标记看过、在资源管理器中显示）：false */
  readonly barrier?: boolean;
  /** 支持 operationId（AI 助手的每次修改都带；网页可以带请求头 Idempotency-Key） */
  readonly idempotent: boolean;
  /** 同步命令：命令层开事务和撤销记录，u 是这次的撤销记录。返回 { message, … } */
  tx?(e: Engine, input: I, u: UndoRecorder): O & { message: string };
  /** 异步、或者自带撤销逻辑的命令（动文件、跑任务、设置） */
  run?(e: Engine, input: I): O | Promise<O>;
  /** 涉及的图片（命令事件里给前端：撤销之后指给用户看） */
  images?(input: I): ID[];
}

export type Def = QueryDef | CommandDef;

export function defineQuery<S extends z.ZodType, O>(
  def: Omit<QueryDef<z.output<S>, O>, 'kind' | 'input'> & { input: S },
): QueryDef<z.output<S>, O> {
  return { ...def, kind: 'query' } as QueryDef<z.output<S>, O>;
}

export function defineCommand<S extends z.ZodType, O>(
  def: Omit<CommandDef<z.output<S>, O>, 'kind' | 'input'> & { input: S },
): CommandDef<z.output<S>, O> {
  if (!def.tx === !def.run) throw new Error(`命令 ${def.name}：tx 和 run 只能给一个`);
  return { ...def, kind: 'command' } as CommandDef<z.output<S>, O>;
}

/** 调用方：谁、带没带 operationId */
export interface CallOptions {
  /** 不给时取当前上下文的 actor（HTTP 请求是 user） */
  actor?: Actor;
  operationId?: string;
  /**
   * operationId 的命名空间：同一个 operationId 在不同调用方之间不冲突。助手按会话（`assistant:<会话>`），网页默认是 actor。
   */
  namespace?: string;
}

/** 写命令的结果附带的说明（HTTP 放在响应头里，MCP、测试直接拿） */
export interface CommandMeta {
  command: string;
  undo: UndoKind;
  /** 这次推出去的最后一个 changed 事件的 id（没有变化是 null）：前端等这个 id 的事件到了就不用自己刷新 */
  eventId: number | null;
  changes: DomainChange[];
  /** 同一个 operationId 的重试，返回的是第一次的结果 */
  replayed?: boolean;
}

export interface Call {
  name: string;
  input: unknown;
}

interface Running {
  actor: Actor;
  command: string;
  events: number[];
  changes: Set<DomainChange>;
}

export class Registry {
  private readonly defs = new Map<string, Def>();
  private readonly metas = new WeakMap<object, CommandMeta>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  readonly audit: Audit;

  constructor(
    readonly engine: Engine,
    defs: readonly Def[],
  ) {
    for (const d of defs) {
      if (this.defs.has(d.name)) throw new Error(`命令 / 查询 ${d.name} 定义了两次`);
      this.defs.set(d.name, d);
    }
    this.audit = new Audit(engine.ctx);
  }

  list(): Def[] {
    return [...this.defs.values()];
  }
  commands(): CommandDef[] {
    return this.list().filter((d): d is CommandDef => d.kind === 'command');
  }
  queries(): QueryDef[] {
    return this.list().filter((d): d is QueryDef => d.kind === 'query');
  }
  get(name: string): Def | undefined {
    return this.defs.get(name);
  }

  /** GET /api/commands：注册表的清单（下一阶段的插件、AI 生成的页面按它找能用的接口和权限范围） */
  catalog(): CommandInfo[] {
    return this.list().map((d) => ({
      name: d.name,
      kind: d.kind,
      summary: d.summary,
      scope: d.scope,
      ...(d.kind === 'command' ? { undoable: d.undoable, idempotent: d.idempotent } : {}),
      http: (d.http ?? []).map((h) => ({ method: h.method, path: h.path, ...(h.legacy ? { legacy: true } : {}) })),
    }));
  }

  private require<K extends Def['kind']>(name: string, kind: K): Extract<Def, { kind: K }> {
    const def = this.defs.get(name);
    if (!def || def.kind !== kind) throw new HttpError(404, 'not_found', `没有这个${kind === 'command' ? '命令' : '查询'}：${name}`);
    return def as Extract<Def, { kind: K }>;
  }

  /** 校验输入（不认识的命令 404，参数不对 400） */
  input(name: string, raw: unknown): unknown {
    const def = this.defs.get(name);
    if (!def) throw new HttpError(404, 'not_found', `没有这个命令：${name}`);
    return parse(def.input, raw);
  }

  /** 执行一个查询 */
  async query<T = unknown>(name: string, raw: unknown = {}, opts: Pick<CallOptions, 'actor'> = {}): Promise<T> {
    const def = this.require(name, 'query');
    const input = parse(def.input, raw);
    const actor = opts.actor ?? currentActor();
    return (await runCall({ actor }, () => def.run(this.engine, input))) as T;
  }

  /** 执行一个写命令 */
  async execute<T = unknown>(name: string, raw: unknown = {}, opts: CallOptions = {}): Promise<T> {
    const def = this.require(name, 'command');
    const input = parse(def.input, raw);
    return this.withKey(def.name, def.idempotent, input, opts, (actor, auditId) =>
      this.perform([{ def, input }], actor, auditId),
    ) as Promise<T>;
  }

  /**
   * 几个同步命令合成一次操作：一个事务、一个撤销令牌（PATCH /api/images/:id 一次改好几项时用）。
   * 提示文案取最后一个命令的；审计记成 `a+b`
   */
  async batch<T = unknown>(calls: readonly Call[], opts: CallOptions = {}): Promise<T> {
    if (!calls.length) throw new BadRequestError('没有要修改的内容');
    if (calls.length === 1) return this.execute(calls[0]!.name, calls[0]!.input, opts);
    const steps = calls.map((c) => {
      const def = this.require(c.name, 'command');
      if (!def.tx) throw new Error(`命令 ${def.name} 不能放进 batch（不是同步命令）`);
      return { def, input: parse(def.input, c.input) };
    });
    const name = steps.map((s) => s.def.name).join('+');
    const idempotent = steps.every((s) => s.def.idempotent);
    return this.withKey(
      name,
      idempotent,
      steps.map((s) => s.input),
      opts,
      (actor, auditId) => this.perform(steps, actor, auditId),
    ) as Promise<T>;
  }

  /** 写命令结果附带的说明（不是写命令的结果返回 undefined） */
  meta(result: unknown): CommandMeta | undefined {
    return result && typeof result === 'object' ? this.metas.get(result) : undefined;
  }

  /** operationId 幂等（只有声明了 idempotent 的命令收 operationId） */
  private async withKey(
    name: string,
    idempotent: boolean,
    input: unknown,
    opts: CallOptions,
    run: (actor: Actor, auditId: number | null) => Promise<unknown>,
  ): Promise<unknown> {
    const actor = opts.actor ?? currentActor();
    // 不支持幂等的命令（标记看过、撤销……）收到 operationId 也照常执行：网页的每个写请求都带 Idempotency-Key
    if (!opts.operationId || !idempotent) return run(actor, null);
    const key = `${opts.namespace ?? actor}:${opts.operationId}`;
    const signature = signatureOf(name, input);
    const running = this.inflight.get(key);
    const existing = this.audit.byKey(key);
    if (existing) {
      if (existing.signature !== signature) throw new ConflictError('operationId 已用于不同操作');
      if (existing.status === 'done') return this.replay(existing);
      if (running) return running;
      throw new ConflictError('此前操作中断，结果待核对；请查询实际状态后再决定下一步');
    }
    const auditId = this.audit.begin({ command: name, actor, key, signature });
    const p = run(actor, auditId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private replay(row: AuditRow): unknown {
    const result =
      row.result === null ? { ok: true, message: row.message ?? '', undoToken: row.undo_token } : (JSON.parse(row.result) as unknown);
    if (result && typeof result === 'object') {
      this.metas.set(result, {
        command: row.command,
        undo: row.undo_token ? 'token' : 'none',
        eventId: null,
        changes: row.changes ? (JSON.parse(row.changes) as DomainChange[]) : [],
        replayed: true,
      });
    }
    return result;
  }

  private async perform(steps: readonly { def: CommandDef; input: unknown }[], actor: Actor, auditId: number | null): Promise<unknown> {
    const name = steps.map((s) => s.def.name).join('+');
    const running: Running = { actor, command: name, events: [], changes: new Set() };
    const e = this.engine;
    let result: unknown;
    try {
      result = await runCall(running, async () => {
        const first = steps[0]!;
        if (steps.length === 1 && first.def.run) return first.def.run(e, first.input);
        // 同步命令：命令层开事务和撤销记录；几个命令共用一份（一个令牌）
        return e.ctx.mutate((u) => {
          let out: { message: string } = { message: '' };
          for (const s of steps) {
            const r = s.def.tx!(e, s.input, u);
            out = r.message ? r : { ...r, message: out.message };
          }
          return out;
        });
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (auditId !== null) {
        this.audit.finish(auditId, { status: 'failed', error });
        // 命令失败时什么都没改：让出 operationId，同一个键可以重试
        this.audit.release(auditId);
      } else this.audit.record({ command: name, actor }, { status: 'failed', error });
      throw err;
    }
    const r = (result ?? {}) as { message?: string; undoToken?: string | null; irreversible?: true };
    const last = steps[steps.length - 1]!.def;
    const undo: UndoKind = r.undoToken
      ? 'token'
      : r.irreversible
        ? 'barrier'
        : steps.some((s) => !s.def.undoable) && last.barrier !== false
          ? 'barrier'
          : 'none';
    const changes = [...running.changes];
    const meta: CommandMeta = { command: name, undo, eventId: running.events.at(-1) ?? null, changes };
    if (result && typeof result === 'object') this.metas.set(result, meta);
    const outcome = { status: 'done' as const, message: r.message ?? null, undoToken: r.undoToken ?? null, changes };
    if (auditId !== null) this.audit.finish(auditId, { ...outcome, result });
    else this.audit.record({ command: name, actor }, outcome);
    if (isInteractive(actor) && undo !== 'none') {
      const images = [...new Set(steps.flatMap((s) => s.def.images?.(s.input) ?? []))].slice(0, 200);
      const event: Omit<CommandEvent, 'id'> = {
        type: 'command',
        name,
        actor,
        message: r.message ?? '',
        undoToken: r.undoToken ?? null,
        undo,
        boot: e.ctx.bus.boot,
        ...(images.length ? { imageIds: images } : {}),
      };
      e.ctx.bus.publish(event);
    }
    return result;
  }
}

/** 涉及的图片：输入里的 ids */
export const byIds = (input: { ids: ID[] }): ID[] => input.ids;
/** 涉及的图片：输入里的 id */
export const byId = (input: { id: ID }): ID[] => [input.id];
