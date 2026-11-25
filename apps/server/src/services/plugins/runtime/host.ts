/**
 * 插件服务端逻辑的运行时（docs/plugins.md 第 6 节，E5）：每个要跑服务端逻辑的插件一个 Node 子进程（./child.cjs）。
 *
 * - 起停：按插件模块算出的 serverPlugins()（装的、启用着、清单写了 server、没有问题的）起子进程；插件变了（plugins.changed，
 *   启用、停用、更新、卸载、撤销）重新对一遍。安全模式下一个都不起。
 * - 隔离：子进程用 Emaki 自己的 Node，带权限参数：只能读插件的包（和 child.cjs），只能读写插件自己的数据目录
 *   （<数据目录>/plugins/data/<id>/），不能再起子进程、不能加载原生模块；限制内存；环境变量只给几个必要的。
 *   联网不拦（Node 的 fetch 照样能用），经 emaki.fetch 的只能连授权里的域名。
 * - 插件的命令：清单里 command@1 登记的，启用时登记进命令注册表（停用时撤掉），和内置命令一样能被视图、AI 助手、HTTP 调用，
 *   执行就是转给子进程；单次调用有超时。
 * - 插件的请求（emaki.call、fetch、storage、settings、secrets、library.import、jobs.start）：都在这里处理，
 *   每次按插件现在的授权查（详情里改了马上生效），记成 plugin:<id>@<版本>。
 * - 崩溃：子进程退出了（没接住的错误、内存超了、启动超时）记一次错误（短时间内多次就自动停用，plugins.ts），按退避时间重启；
 *   正在等它的调用、正在跑的任务都失败，Emaki 照常。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CommandContribution, Grant, ImportImagesResult, ServerEvent } from '@emaki/shared';
import { z } from 'zod';
import type { CommandDef, Engine } from '../../../commands/registry.ts';
import type { JobContext } from '../../../core/jobs.ts';
import { ConflictError, HttpError } from '../../../http/errors.ts';
import { httpFetch, type HttpInit } from '../../../net/http.ts';
import { currentActor, pluginActor, runCall } from '../../../propagation/actor.ts';

const CHILD = path.join(import.meta.dirname, 'child.cjs');

/** Node 22.13 之前权限开关叫 --experimental-permission */
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

/** 子进程能看到的环境变量（其余的不给：可能有令牌、代理密码） */
const ENV_KEYS = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'LANG', 'TZ', 'HOME', 'USERPROFILE']);

export interface RuntimeOptions {
  log?: (message: string) => void;
  /** 连续崩溃后第 n 次重启前等多久（毫秒），超出取最后一个 */
  backoffMs?: readonly number[];
  /** 子进程连续正常跑这么久，崩溃次数清零 */
  stableMs?: number;
  /** 一次命令最多等多久 */
  callTimeoutMs?: number;
  /** 启动（activate）最多等多久 */
  startTimeoutMs?: number;
  /** 取消任务后最多等插件自己停下多久 */
  cancelGraceMs?: number;
  /** 子进程的堆内存上限（MB） */
  memoryMb?: number;
  /** emaki.fetch 用的（测试里换掉） */
  fetch?: (url: string, init: HttpInit) => Promise<Response>;
}

const DEFAULTS = {
  backoffMs: [1_000, 5_000, 30_000, 120_000] as readonly number[],
  stableMs: 60_000,
  callTimeoutMs: 60_000,
  startTimeoutMs: 20_000,
  cancelGraceMs: 10_000,
  memoryMb: 256,
};

/** emaki.fetch：一次读进内存的最大响应、存成文件的最大大小 */
const FETCH_LIMITS = { bodyBytes: 64 * 1024 * 1024, fileBytes: 512 * 1024 * 1024, redirects: 5 };

type Spec = ReturnType<Engine['plugins']['serverPlugins']>[number];

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(e: Error): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Proc {
  spec: Spec;
  /** 数据目录的真实路径（判断路径在不在里面用） */
  data: string;
  child: ChildProcess | null;
  state: 'starting' | 'ready' | 'backoff' | 'stopped';
  ready: Deferred;
  defs: CommandDef[];
  calls: Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>;
  jobs: Map<string, { ctx: JobContext; resolve(v: string | void): void; reject(e: Error): void }>;
  subs: Set<string>;
  crashes: number;
  fatal: string | null;
  timers: Set<NodeJS.Timeout>;
}

/** 插件那边的错：原样告诉调用方（502，信息是插件给的） */
const pluginError = (message: string) => new HttpError(502, 'internal', message);

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

const hostAllowed = (host: string, allowed: readonly string[]) =>
  allowed.some((a) => {
    const h = a.toLowerCase().replace(/^\*\./, '');
    return host === h || host.endsWith(`.${h}`);
  });

export class PluginRuntime {
  private readonly procs = new Map<string, Proc>();
  private readonly o: typeof DEFAULTS & RuntimeOptions;
  private off: (() => void) | null = null;
  private seq = 0;
  private closed = false;
  private pendingReconcile = false;

  constructor(
    private readonly engine: Engine,
    options: RuntimeOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...options };
  }

  /** 开始：按现在的插件起子进程，之后插件变了就重新对一遍 */
  start(): void {
    this.off = this.engine.ctx.bus.subscribe((e) => {
      if (e.type === 'changed' && e.changes.includes('plugins.changed')) this.reconcileSoon();
      this.forward(e);
    });
    this.reconcile();
  }

  /** 关掉全部子进程（Emaki 退出时） */
  async close(): Promise<void> {
    this.closed = true;
    this.off?.();
    const exits = [...this.procs.keys()].map((id) => this.stop(id));
    await Promise.all(exits);
  }

  /** 一个插件的服务端现在怎么样（测试、以后的详情页用） */
  status(id: string): { state: Proc['state']; crashes: number; pid: number | null } | null {
    const p = this.procs.get(id);
    return p ? { state: p.state, crashes: p.crashes, pid: p.child?.pid ?? null } : null;
  }

  /** 等一个插件的服务端起好（测试用） */
  async ready(id: string): Promise<void> {
    // 刚装上、刚启用的：plugins.changed 的重新对一遍还在排队，先对一遍
    if (!this.procs.has(id)) this.reconcile();
    const p = this.procs.get(id);
    if (!p) throw new ConflictError(`插件「${id}」没有在运行`);
    await p.ready.promise;
  }

  reconcile(): void {
    if (this.closed) return;
    const wanted = new Map(this.engine.plugins.serverPlugins().map((s) => [s.id, s]));
    for (const [id, p] of this.procs) {
      const w = wanted.get(id);
      if (!w || w.version !== p.spec.version || w.dir !== p.spec.dir || w.entry !== p.spec.entry) void this.stop(id);
    }
    for (const [id, spec] of wanted) if (!this.procs.has(id)) this.launch(spec);
  }

  private reconcileSoon(): void {
    if (this.pendingReconcile) return;
    this.pendingReconcile = true;
    setImmediate(() => {
      this.pendingReconcile = false;
      this.reconcile();
    });
  }

  // ---------------------------------------------------------------- 起停

  private launch(spec: Spec): void {
    mkdirSync(spec.dataDir, { recursive: true });
    const p: Proc = {
      spec,
      data: realpathSync(spec.dataDir),
      child: null,
      state: 'starting',
      ready: deferred(),
      defs: [],
      calls: new Map(),
      jobs: new Map(),
      subs: new Set(),
      crashes: 0,
      fatal: null,
      timers: new Set(),
    };
    this.procs.set(spec.id, p);
    for (const c of spec.manifest.contributes['command@1'] ?? []) {
      try {
        const def = this.commandDef(spec.id, c);
        this.engine.registry.define(def);
        p.defs.push(def);
      } catch (e) {
        this.log(spec.id, `命令 ${c.name} 登记不上：${(e as Error).message}`);
      }
    }
    this.spawn(p);
  }

  private spawn(p: Proc): void {
    const s = p.spec;
    p.state = 'starting';
    p.fatal = null;
    p.subs.clear();
    let pkg: string;
    try {
      pkg = realpathSync(s.dir);
    } catch {
      this.crashed(p, null, '插件的文件不见了');
      return;
    }
    const execArgv = [
      PERMISSION_FLAG,
      `--allow-fs-read=${pkg}`,
      `--allow-fs-read=${p.data}`,
      `--allow-fs-write=${p.data}`,
      `--allow-fs-read=${CHILD}`,
      `--max-old-space-size=${this.o.memoryMb}`,
    ];
    // Windows 上环境变量名不分大小写（Path、PATH）：按原来的名字给一份
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_KEYS.has(k.toUpperCase())) env[k] = v;
    let child: ChildProcess;
    try {
      child = fork(CHILD, [], { execArgv, cwd: p.data, env, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) {
      this.crashed(p, null, `起不来：${(e as Error).message}`);
      return;
    }
    p.child = child;
    const lines = (stream: NodeJS.ReadableStream | null) =>
      stream?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) this.log(s.id, line.slice(0, 2000));
      });
    lines(child.stdout);
    lines(child.stderr);
    child.on('message', (m) => this.onMessage(p, child, m));
    child.on('error', (e) => {
      if (p.child === child) p.fatal ??= e.message;
    });
    child.on('exit', (code, signal) => {
      if (p.child !== child) return;
      p.child = null;
      this.crashed(p, child, p.fatal ?? (signal ? `被结束了（${signal}）` : code === 0 ? '自己退出了' : `退出了（退出码 ${code}）`));
    });
    const startTimer = this.timer(p, this.o.startTimeoutMs, () => {
      if (p.child === child && p.state === 'starting') {
        p.fatal = `${this.o.startTimeoutMs / 1000} 秒内没有启动好（activate 没有返回）`;
        child.kill('SIGKILL');
      }
    });
    p.ready.promise.then(() => clearTimeout(startTimer)).catch(() => {});
    this.post(p, { t: 'init', id: s.id, version: s.version, name: s.name, entry: path.join(pkg, ...s.entry.split('/')), dataDir: p.data });
  }

  /** 子进程没了（不是我们停的）：失败掉在等它的，记一次错误，按退避时间重启 */
  private crashed(p: Proc, _child: ChildProcess | null, reason: string): void {
    this.failAll(p, `插件的服务端停了：${reason}`);
    if (p.state === 'stopped' || this.closed) return;
    p.crashes += 1;
    p.state = 'backoff';
    const old = p.ready;
    p.ready = deferred();
    // 等它的调用继续等下一次启动（超时由调用自己管）
    p.ready.promise.then(old.resolve, old.reject);
    this.log(p.spec.id, `服务端停了：${reason}`);
    try {
      // 可能因此自动停用：plugins.changed → reconcile 会把它停掉
      this.engine.plugins.recordError(p.spec.id, '服务端', reason);
    } catch {
      // 插件已经删掉了
    }
    const delay = this.o.backoffMs[Math.min(p.crashes - 1, this.o.backoffMs.length - 1)] ?? 1000;
    this.timer(p, delay, () => {
      if (p.state === 'backoff' && this.procs.get(p.spec.id) === p) this.spawn(p);
    });
  }

  private stop(id: string): Promise<void> {
    const p = this.procs.get(id);
    if (!p) return Promise.resolve();
    this.procs.delete(id);
    p.state = 'stopped';
    for (const t of p.timers) clearTimeout(t);
    p.timers.clear();
    for (const d of p.defs) this.engine.registry.undefine(d);
    p.ready.reject(new ConflictError('插件的服务端停了'));
    this.failAll(p, '插件停用了');
    const child = p.child;
    p.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        if (child.connected) child.send({ t: 'shutdown' });
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    });
  }

  private failAll(p: Proc, message: string): void {
    for (const c of p.calls.values()) {
      clearTimeout(c.timer);
      c.reject(pluginError(message));
    }
    p.calls.clear();
    for (const j of p.jobs.values()) j.reject(new Error(message));
    p.jobs.clear();
  }

  private timer(p: Proc, ms: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => {
      p.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    p.timers.add(t);
    return t;
  }

  private post(p: Proc, msg: object): boolean {
    const child = p.child;
    if (!child?.connected) return false;
    try {
      child.send(msg);
      return true;
    } catch (e) {
      this.log(p.spec.id, `发给插件的消息没发出去：${(e as Error).message}`);
      return false;
    }
  }

  private log(id: string, message: string): void {
    (this.o.log ?? ((m: string) => console.log(m)))(`[插件 ${id}] ${message}`);
  }

  // ---------------------------------------------------------------- 插件的命令

  private commandDef(id: string, c: CommandContribution): CommandDef {
    return {
      kind: 'command',
      name: c.name,
      summary: c.summary,
      scope: c.scope,
      input: z.fromJSONSchema((c.input ?? { type: 'object' }) as Parameters<typeof z.fromJSONSchema>[0]),
      // 插件的命令不可撤销，也不占撤销栈（它要改图库，经 emaki.call 调的内置命令自己能撤销）
      undoable: false,
      barrier: false,
      idempotent: false,
      run: async (_e, input) => {
        const value = await this.invoke(id, c.name, input);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
      },
    };
  }

  private async whenReady(p: Proc): Promise<void> {
    if (p.state === 'ready') return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        p.ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(pluginError('插件的服务端还没有启动好')), this.o.startTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async invoke(id: string, name: string, input: unknown): Promise<unknown> {
    const p = this.procs.get(id);
    if (!p) throw new ConflictError('这个插件的服务端没有在运行');
    await this.whenReady(p);
    return new Promise((resolve, reject) => {
      const rid = ++this.seq;
      const timer = setTimeout(() => {
        p.calls.delete(rid);
        reject(new HttpError(504, 'internal', `插件 ${this.o.callTimeoutMs / 1000} 秒内没有回应`));
      }, this.o.callTimeoutMs);
      p.calls.set(rid, { resolve, reject, timer });
      if (!this.post(p, { t: 'command', rid, name, input, caller: currentActor() })) {
        clearTimeout(timer);
        p.calls.delete(rid);
        reject(pluginError('插件的服务端没有在运行'));
      }
    });
  }

  // ---------------------------------------------------------------- 插件的任务

  private async runJob(id: string, kind: string, input: unknown, ctx: JobContext): Promise<string | void> {
    const p = this.procs.get(id);
    if (!p) throw new Error('插件停用了');
    await this.whenReady(p);
    const jobId = ctx.jobId!;
    return new Promise<string | void>((resolve, reject) => {
      const done = () => ctx.signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        this.post(p, { t: 'cancel', jobId });
        // 插件不理取消：过一会儿直接算取消（不占着任务的通道）
        this.timer(p, this.o.cancelGraceMs, () => {
          const j = p.jobs.get(jobId);
          if (!j) return;
          p.jobs.delete(jobId);
          j.reject(new Error('已取消'));
        });
      };
      p.jobs.set(jobId, {
        ctx,
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (!this.post(p, { t: 'job', jobId, kind, input })) {
        p.jobs.delete(jobId);
        done();
        reject(new Error('插件的服务端没有在运行'));
      }
    });
  }

  // ---------------------------------------------------------------- 子进程发来的

  private onMessage(p: Proc, child: ChildProcess, raw: unknown): void {
    if (p.child !== child || !raw || typeof raw !== 'object') return;
    const m = raw as Record<string, unknown>;
    switch (m.t) {
      case 'ready': {
        p.state = 'ready';
        p.ready.resolve();
        const handled = new Set(Array.isArray(m.commands) ? m.commands.map(String) : []);
        for (const d of p.defs) if (!handled.has(d.name)) this.log(p.spec.id, `清单里的命令 ${d.name} 没有实现（commands.handle）`);
        // 正常跑了一阵：崩溃次数清零
        this.timer(p, this.o.stableMs, () => {
          if (p.child === child) p.crashes = 0;
        });
        break;
      }
      case 'result': {
        const c = p.calls.get(Number(m.rid));
        if (!c) break;
        p.calls.delete(Number(m.rid));
        clearTimeout(c.timer);
        if (m.ok) c.resolve(m.value);
        else c.reject(pluginError(String(m.error ?? '插件出错了')));
        break;
      }
      case 'progress': {
        const j = p.jobs.get(String(m.jobId));
        if (!j) break;
        const message = typeof m.message === 'string' ? m.message.slice(0, 200) : undefined;
        if ('total' in m) j.ctx.setTotal(typeof m.total === 'number' && Number.isFinite(m.total) && m.total >= 0 ? m.total : null);
        if (typeof m.advance === 'number' && m.advance > 0) j.ctx.advance(m.advance, message);
        else if (message) j.ctx.setMessage(message);
        break;
      }
      case 'jobDone': {
        const j = p.jobs.get(String(m.jobId));
        if (!j) break;
        p.jobs.delete(String(m.jobId));
        if (m.ok) j.resolve(typeof m.value === 'string' ? m.value.slice(0, 200) : undefined);
        else j.reject(new Error(String(m.error ?? '插件的任务失败了')));
        break;
      }
      case 'req':
        void this.onRequest(p, child, m);
        break;
      case 'sub': {
        const type = String(m.type);
        const grant = this.engine.plugins.serverGrant(p.spec.id)?.grant;
        if (type !== 'changed' && type !== 'job') this.log(p.spec.id, `不能订阅「${type}」（只有 changed、job）`);
        else if (!grant?.background) this.log(p.spec.id, `订阅「${type}」要授权在后台运行（permissions.background）`);
        else p.subs.add(type);
        break;
      }
      case 'log':
        this.log(p.spec.id, String(m.text ?? '').slice(0, 2000));
        break;
      case 'fatal':
        p.fatal = String(m.message ?? '').slice(0, 500) || null;
        break;
    }
  }

  private async onRequest(p: Proc, child: ChildProcess, m: Record<string, unknown>): Promise<void> {
    let reply: object;
    try {
      const value = await this.handle(p, String(m.op), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>);
      reply = { t: 'reply', rid: m.rid, ok: true, value: value === undefined ? null : value };
    } catch (e) {
      reply = { t: 'reply', rid: m.rid, ok: false, error: (e as Error)?.message ?? String(e), code: (e as HttpError)?.code };
    }
    if (p.child === child) this.post(p, reply);
  }

  /** 插件的一个请求：每次按现在的授权查 */
  private async handle(p: Proc, op: string, a: Record<string, unknown>): Promise<unknown> {
    const id = p.spec.id;
    const current = this.engine.plugins.serverGrant(id);
    if (!current) throw new ConflictError('插件停用了');
    const { grant, version } = current;
    const actor = pluginActor(id, version);
    const scoped = <T>(fn: () => T): T => runCall({ actor, grant: new Set(grant.scopes) }, fn);
    const registry = this.engine.registry;
    const plugins = this.engine.plugins;
    const key = () => {
      if (typeof a.key !== 'string' || !a.key) throw new Error('key 要是字符串');
      return a.key;
    };
    switch (op) {
      case 'call': {
        const name = String(a.name);
        // 带本机路径的命令：插件只能放自己文件夹里的、放进授权给的文件夹
        if (name === 'library.import' || name === 'library.replace')
          throw new Error('导入图片用 emaki.library.import（放进授权给的文件夹）');
        const def = registry.get(name);
        if (!def) throw new Error(`没有这个命令：${name}`);
        const result =
          def.kind === 'query'
            ? await scoped(() => registry.query(name, a.input ?? {}, { actor }))
            : await scoped(() => registry.execute(name, a.input ?? {}, { actor }));
        // 文件这类结果（图片的流）不能原样发过去：只给能转成 JSON 的
        return result === undefined ? null : (JSON.parse(JSON.stringify(result)) as unknown);
      }
      case 'fetch':
        return this.fetch(p, grant, a);
      case 'storage.get':
        return plugins.storage.get(id, key()) ?? null;
      case 'storage.set':
        plugins.storage.set(id, key(), a.value);
        return null;
      case 'storage.delete':
        plugins.storage.delete(id, key());
        return null;
      case 'storage.list':
        return plugins.storage.keys(id, typeof a.prefix === 'string' ? a.prefix : '');
      case 'settings.get':
      case 'secrets.get':
        return plugins.settings.get(id, key());
      case 'secrets.set': {
        const k = key();
        const declared = p.spec.manifest.contributes['setting@1']?.find((s) => s.id === k);
        if (declared && declared.type !== 'secret') throw new Error(`「${k}」是普通设置，不是凭证`);
        if (a.value !== null && typeof a.value !== 'string') throw new Error('凭证要是字符串');
        plugins.settings.put(id, k, a.value as string | null, true);
        return null;
      }
      case 'library.import':
        return this.importFiles(p, grant, actor, scoped, a);
      case 'jobs.start': {
        if (!grant.background) throw new Error('没有授权在后台运行（清单 permissions.background）');
        const kind = String(a.kind);
        const decl = p.spec.manifest.contributes['job.kind@1']?.find((j) => j.kind === kind);
        if (!decl) throw new Error(`清单里没有登记任务「${kind}」（job.kind@1）`);
        const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 60) : decl.label;
        const input = a.input ?? {};
        const job = this.engine.ctx.jobs.enqueueTask({ title, plugin: id, run: (ctx) => this.runJob(id, kind, input, ctx) });
        return { id: job.id };
      }
      default:
        throw new Error(`不认识的请求：${op}`);
    }
  }

  /** 数据目录里的一个路径（相对的按数据目录算）；mustExist 时按真实路径再查一遍（不能经链接跳出去） */
  private inData(p: Proc, raw: string, mustExist = false): string {
    const abs = path.resolve(p.data, raw);
    if (!within(abs, p.data)) throw new Error(`路径要在插件自己的文件夹里：${raw}`);
    if (!mustExist) return abs;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new Error(`找不到这个文件：${raw}`);
    }
    if (!within(real, p.data)) throw new Error(`路径要在插件自己的文件夹里：${raw}`);
    return real;
  }

  /** library.import：插件文件夹里下载好的图 → 授权里给的文件夹（经 library.import 命令：去重、入库、识别都走现有的路，能撤销） */
  private async importFiles(
    p: Proc,
    grant: Grant,
    actor: ReturnType<typeof pluginActor>,
    scoped: <T>(fn: () => T) => T,
    a: Record<string, unknown>,
  ): Promise<{ items: ImportImagesResult['items']; message: string }> {
    const folder = typeof a.folder === 'string' ? grant.folders.find((f) => f.id === a.folder) : grant.folders[0];
    if (!folder)
      throw new Error(
        typeof a.folder === 'string' ? `授权里没有文件夹「${a.folder}」` : '授权里没有给放图的文件夹（清单 permissions.folders）',
      );
    const files = Array.isArray(a.files) ? (a.files as unknown[]) : [];
    if (!files.length || files.length > 1000) throw new Error('files 要有 1 到 1000 个');
    const list = files.map((f) => {
      const o = (typeof f === 'string' ? { path: f } : f) as { path?: unknown; fileName?: unknown };
      if (typeof o?.path !== 'string') throw new Error('files 里每一项要有 path');
      return { path: this.inData(p, o.path, true), ...(typeof o.fileName === 'string' && o.fileName && { fileName: o.fileName }) };
    });
    const items: ImportImagesResult['items'] = [];
    let added = 0;
    for (let i = 0; i < list.length; i += 20) {
      const r = await scoped(() =>
        this.engine.registry.execute<ImportImagesResult>(
          'library.import',
          { rootId: String(folder.rootId), dir: folder.dir, files: list.slice(i, i + 20), keepBoth: a.keepBoth !== false },
          { actor },
        ),
      );
      items.push(...r.items);
      added += r.items.filter((x) => x.status === 'imported').length;
    }
    const existing = items.filter((x) => x.status === 'existing').length;
    return {
      items: JSON.parse(JSON.stringify(items)) as typeof items,
      message: `新加了 ${added} 张${existing ? `，${existing} 张图库里已经有了` : ''}`,
    };
  }

  /** emaki.fetch：走 Emaki 的代理设置，只能连授权里的域名（跳转也查）；saveAs 时存进插件的文件夹 */
  private async fetch(p: Proc, grant: Grant, a: Record<string, unknown>): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(String(a.url));
    } catch {
      throw new Error(`地址不对：${String(a.url)}`);
    }
    let method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET';
    const headers: Record<string, string> = {};
    if (a.headers && typeof a.headers === 'object')
      for (const [k, v] of Object.entries(a.headers as Record<string, unknown>)) if (v !== undefined && v !== null) headers[k] = String(v);
    let body: string | Uint8Array | undefined =
      a.json !== undefined ? JSON.stringify(a.json) : typeof a.body === 'string' || a.body instanceof Uint8Array ? a.body : undefined;
    if (a.json !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = 'application/json';
    const saveAs = typeof a.saveAs === 'string' ? this.inData(p, a.saveAs) : null;
    const timeoutMs = Math.min(Math.max(Number(a.timeoutMs) || (saveAs ? 300_000 : 60_000), 1_000), 600_000);
    const signal = AbortSignal.timeout(timeoutMs);
    const doFetch = this.o.fetch ?? ((u: string, init: HttpInit) => httpFetch(u, init) as unknown as Promise<Response>);

    let res: Response;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只能连 http、https 的地址');
      if (!hostAllowed(url.hostname.toLowerCase(), grant.network))
        throw new Error(`没有授权连接 ${url.hostname}（在清单的 permissions.network 里声明，授权单上确认）`);
      res = await doFetch(url.href, { method, headers, ...(body !== undefined && { body }), signal, redirect: 'manual' });
      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;
      await res.body?.cancel().catch(() => {});
      if (hop >= FETCH_LIMITS.redirects) throw new Error('跳转太多次了');
      url = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
    const meta = { status: res.status, ok: res.ok, url: url.href, headers: Object.fromEntries(res.headers.entries()) };

    if (saveAs) {
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return meta;
      }
      mkdirSync(path.dirname(saveAs), { recursive: true });
      const part = `${saveAs}.part`;
      const handle = await open(part, 'w');
      let size = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > FETCH_LIMITS.fileBytes) throw new Error(`文件超过 ${FETCH_LIMITS.fileBytes / 1024 / 1024} MB`);
          await handle.write(chunk);
        }
      } catch (e) {
        await handle.close();
        await rm(part, { force: true });
        throw e;
      }
      await handle.close();
      await rename(part, saveAs);
      return { ...meta, path: saveAs, size };
    }

    const declared = Number(res.headers.get('content-length'));
    if (declared > FETCH_LIMITS.bodyBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`响应超过 ${FETCH_LIMITS.bodyBytes / 1024 / 1024} MB，用 saveAs 存成文件`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > FETCH_LIMITS.bodyBytes)
      throw new Error(`响应超过 ${FETCH_LIMITS.bodyBytes / 1024 / 1024} MB，用 saveAs 存成文件`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const as =
      a.as === 'json' || a.as === 'text' || a.as === 'bytes'
        ? a.as
        : type.includes('json')
          ? 'json'
          : /^text\/|xml|javascript/.test(type)
            ? 'text'
            : 'bytes';
    if (as === 'bytes') return { ...meta, body: bytes };
    const text = new TextDecoder().decode(bytes);
    if (as === 'text') return { ...meta, body: text };
    try {
      return { ...meta, body: JSON.parse(text) as unknown };
    } catch {
      if (a.as === 'json') throw new Error(`返回的不是 JSON（HTTP ${res.status}）`);
      return { ...meta, body: text };
    }
  }

  // ---------------------------------------------------------------- 事件

  /** 订阅了的插件：图库变了（changed）、自己的任务变了（job）。只是事后告诉它，拦不下来 */
  private forward(e: ServerEvent): void {
    for (const p of this.procs.values()) {
      if (p.state !== 'ready' || !p.subs.has(e.type)) continue;
      // 转给插件（不是在这里推事件）
      if (e.type === 'changed') this.post(p, { t: 'event', type: e.type, data: { changes: e.changes, reason: e.reason, actor: e.actor } });
      else if (e.type === 'job' && e.job.plugin === p.spec.id) this.post(p, { t: 'event', type: e.type, data: e.job });
    }
  }
}
