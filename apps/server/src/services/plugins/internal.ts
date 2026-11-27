/**
 * 改内部的插件（第 3 层，docs/plugins.md 第 7 节，E6）：在 Emaki 自己的进程里加载插件清单里的 internal 入口，
 * 让它给登记过名字的内部点（core/points.ts）打补丁。
 *
 * - 起停：按插件模块算出的 internalPlugins()（装的、启用着、有 patch@1、授权了「改内部」、没有问题的）加载；
 *   只改网页的插件（没有 internal）这里只对指纹，代码由网页加载（apps/web/src/features/plugins/internal/）；
 *   插件变了（plugins.changed：启用、停用、更新、卸载、撤销）重新对一遍。停用、卸载就撤掉它的全部补丁。安全模式下一个都不加载。
 * - 先对指纹：装上、启用时记下了它改的每个点的指纹；现在对不上（Emaki 更新以后那个点变了）就不加载，自动停用并通知，
 *   你在插件详情里「仍然启用」以后按现在的样子重新记（domain/plugins/plugins.ts）。
 * - 加载：import 入口（地址带版本和文件的修改时间：同一个进程里换了代码也能重新加载），调它导出的 activate(internal)。
 *   internal.patch 只能改清单 patch@1 里列的点；internal.engine 是整个引擎（没登记的内部，完全不保证兼容）。
 *   activate 抛错：撤掉已经加上的补丁，记一次错误。
 * - 加载完马上试一下它改的点（Points.verify）：口径是拼进 SQL 的片段，坏了要到排名时才炸、也看不出是谁，这里试跑一条查询，
 *   坏了当加载失败（撤掉补丁、记在它头上）。
 * - 补丁自己抛的错记在这个插件头上（短时间内多次就自动停用，和别的插件出错一样），照样往外抛。
 * - 加上、撤掉补丁以后声明 plugins.changed：派生的缓存强刷新、网页重新取（张数这类数跟着变）。
 * - 接连崩溃的恢复（第 8 节）：改内部的代码跑在 Emaki 自己的进程里，坏了能让后端一启动就崩。启动时加载前先记一笔
 *   （bootFile：这次要加载哪几个、这是连着第几次），跑稳 stableMs 或者正常退出就擦掉。连着 CRASH_STARTS 次没擦掉，
 *   这次就不加载它们、自动停用（写明原因、发通知），别的照常——等于退回没有它们的那份配置。只改网页的不算（不在这个进程里跑）。
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Engine } from '../../commands/registry.ts';
import type { PatchSpec, PointInfo } from '../../core/points.ts';
import { pluginActor } from '../../propagation/actor.ts';

type Spec = ReturnType<Engine['plugins']['internalPlugins']>[number];

/** activate(internal) 拿到的东西 */
export interface InternalApi {
  plugin: { id: string; version: string };
  /** 给一个内部点加补丁（只能是清单 patch@1 里列的），返回撤掉它的函数；插件停用时 Emaki 自己全部撤掉 */
  patch(point: string, spec: PatchSpec): () => void;
  /** 登记过的内部点（名字、种类、人话、谁改了） */
  points(): PointInfo[];
  /** 整个引擎：没登记的内部，完全不保证兼容 */
  engine: Engine;
  log(...args: unknown[]): void;
}

export interface InternalOptions {
  log?: (message: string) => void;
  /** 接连崩溃的恢复记在这个文件里（不给就不管：测试、演示）。一般是 <数据目录>/plugins/internal-boot.json */
  bootFile?: string;
  /** 加载完跑多久算跑稳，默认 30 秒 */
  stableMs?: number;
}

/** 连着这么多次启动加载完没跑稳（崩了、被强杀），下一次就不加载、自动停用 */
export const CRASH_STARTS = 2;

/** 启动时记的一笔：这次加载哪几个（有服务端代码的）、这是连着第几次 */
interface BootMark {
  starts: number;
  plugins: string[];
  at: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class InternalPlugins {
  private readonly loaded = new Map<string, { spec: Spec; key: string }>();
  private offs: (() => void)[] = [];
  private closed = false;
  /** 一次只对一遍（import 是异步的） */
  private queue: Promise<void> = Promise.resolve();
  private pending = false;
  private stable: NodeJS.Timeout | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly o: InternalOptions = {},
  ) {}

  /** 开始：按现在的插件加载，之后插件变了就重新对一遍 */
  start(): Promise<void> {
    this.offs.push(
      this.engine.ctx.bus.subscribe((e) => {
        if (e.type === 'changed' && e.changes.includes('plugins.changed')) this.reconcileSoon();
      }),
      // 补丁出错记在插件头上：放到下一轮，不进出错的那个事务（它会回滚）
      this.engine.ctx.points.onPatchError((owner, point, err) =>
        setImmediate(() => {
          if (this.closed || !this.loaded.has(owner)) return;
          try {
            this.engine.plugins.recordError(owner, '改内部', `${point}：${message(err)}`);
          } catch {
            // 插件已经删了
          }
        }),
      ),
    );
    this.guardBoot();
    return this.reconcile().then(() => {
      if (!this.o.bootFile || this.closed) return;
      // 跑稳了：擦掉这次记的（不拖住进程退出）
      this.stable = setTimeout(() => this.clearBoot(), this.o.stableMs ?? 30_000);
      this.stable.unref();
    });
  }

  /** 撤掉全部补丁（Emaki 退出时）；正常退出不算崩溃，擦掉启动时记的 */
  close(): void {
    if (!this.closed) this.clearBoot();
    this.closed = true;
    if (this.stable) clearTimeout(this.stable);
    for (const off of this.offs.splice(0)) off();
    for (const id of this.loaded.keys()) this.engine.ctx.points.removeOwner(id);
    this.loaded.clear();
  }

  /** 现在加载着的（测试、以后的详情页用） */
  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  /** 对一遍；返回的 Promise 在这一遍做完时好 */
  reconcile(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcileNow()).catch((e) => this.log(`改内部的插件加载出错：${message(e)}`));
    return this.queue;
  }

  private reconcileSoon(): void {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      void this.reconcile();
    });
  }

  /**
   * 加载前：上几次启动都没跑稳就先停掉那几次要加载的（不知道是哪一个，一起停），再记下这一次的。
   * 读写这个文件出错不挡启动
   */
  private guardBoot(): void {
    const file = this.o.bootFile;
    if (!file) return;
    const plugins = this.engine.plugins;
    const mark = readMark(file);
    let running = plugins.internalPlugins().filter((s) => s.entry).map((s) => s.id);
    let starts = (mark?.starts ?? 0) + 1;
    if (mark && mark.starts >= CRASH_STARTS) {
      const suspects = running.filter((id) => mark.plugins.includes(id));
      if (suspects.length) {
        this.log(`Emaki 连着 ${mark.starts} 次启动后没多久就停了，这次不加载改内部的插件：${suspects.join('、')}`);
        plugins.autoDisableCrashed(suspects, mark.starts);
        running = running.filter((id) => !suspects.includes(id));
      }
      starts = 1;
    }
    try {
      if (!running.length) rmSync(file, { force: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ starts, plugins: running, at: new Date().toISOString() } satisfies BootMark));
      }
    } catch (e) {
      this.log(`记不了改内部的插件的启动记录：${message(e)}`);
    }
  }

  private clearBoot(): void {
    if (!this.o.bootFile) return;
    try {
      rmSync(this.o.bootFile, { force: true });
    } catch {
      // 下次启动再算
    }
  }

  private async reconcileNow(): Promise<void> {
    if (this.closed) return;
    const plugins = this.engine.plugins;
    const wanted = new Map(plugins.internalPlugins().map((s) => [s.id, s]));
    const touched: Spec[] = [];
    for (const [id, l] of this.loaded) {
      const w = wanted.get(id);
      if (w && keyOf(w) === l.key) continue;
      this.engine.ctx.points.removeOwner(id);
      this.loaded.delete(id);
      // 只改网页的：服务端的补丁没变（网页按 plugins.changed 自己换）
      if (l.spec.entry) touched.push(l.spec);
    }
    for (const [id, spec] of wanted) {
      if (this.loaded.has(id)) continue;
      // Emaki 更新以后它改的点变了：不加载，自动停用（之后的 plugins.changed 再对一遍时它已经不在 wanted 里）
      const changed = plugins.pointsChanged(id);
      if (changed.length) {
        this.log(`「${spec.name}」改的内部点变了（${changed.join('、')}），不加载、自动停用`);
        plugins.autoDisableChanged(id, changed);
        continue;
      }
      // 指纹的算法换过（旧前缀）：点没变，按现在的算法重记
      plugins.upgradePrints(id);
      try {
        await this.load(spec);
        if (spec.entry) touched.push(spec);
      } catch (e) {
        this.engine.ctx.points.removeOwner(id);
        this.log(`「${spec.name}」改内部的代码加载不了：${message(e)}`);
        plugins.recordError(id, '改内部', `加载不了：${message(e)}`);
      }
      if (this.closed) return;
    }
    // 补丁变了：张数这类数跟着变，缓存强刷新、网页重新取
    const last = touched.at(-1);
    if (last) plugins.patchesChanged(pluginActor(last.id, last.version));
  }

  private async load(spec: Spec): Promise<void> {
    const key = keyOf(spec);
    // 只改网页的：这里只对指纹，代码由网页加载（PluginsState.webPatches）
    if (!spec.entry) {
      this.loaded.set(spec.id, { spec, key });
      return;
    }
    const file = path.join(spec.dir, ...spec.entry.split('/'));
    const mod = (await import(`${pathToFileURL(file).href}?v=${encodeURIComponent(key)}`)) as {
      activate?: (api: InternalApi) => unknown;
      default?: { activate?: (api: InternalApi) => unknown };
    };
    const activate = mod.activate ?? mod.default?.activate;
    if (typeof activate !== 'function') throw new Error(`${spec.entry} 没有导出 activate(internal)`);
    const declared = new Set(spec.points);
    const points = this.engine.ctx.points;
    const api: InternalApi = {
      plugin: { id: spec.id, version: spec.version },
      patch: (point, p) => {
        if (!declared.has(point)) throw new Error(`「${point}」没有写在清单的 patch@1 里，改不了`);
        return points.patch(point, spec.id, p);
      },
      points: () => points.list(),
      engine: this.engine,
      log: (...args) => this.log(`[${spec.name}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`),
    };
    await activate(api);
    // 试一下它改的点（口径：拼进 SQL 试跑）；坏了当加载失败，调用的地方撤掉补丁、记在它头上
    for (const point of spec.points) {
      try {
        points.verify(point);
      } catch (e) {
        throw new Error(`改过的「${points.label(point)}」用不了：${message(e)}`);
      }
    }
    this.loaded.set(spec.id, { spec, key });
  }

  private log(m: string): void {
    this.o.log?.(m);
  }
}

/** 启动时记的那一笔；没有（上次跑稳了）、坏了是 null，从头算 */
function readMark(file: string): BootMark | null {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<BootMark>;
    return typeof m.starts === 'number' && Array.isArray(m.plugins) ? { starts: m.starts, plugins: m.plugins.map(String), at: String(m.at) } : null;
  } catch {
    return null;
  }
}

/** 版本、位置、入口文件的修改时间：变了就重新加载（按文件夹装的插件改了代码、「重新读取」以后） */
function keyOf(s: Spec): string {
  let mtime = 0;
  try {
    if (s.entry) mtime = statSync(path.join(s.dir, ...s.entry.split('/'))).mtimeMs;
  } catch {
    // 文件不见了：加载时报错
  }
  return `${s.version}|${s.dir}|${s.entry}|${mtime}|${s.points.join(',')}`;
}
