/**
 * 内部点（docs/plugins.md 第 7 节，E6）：第 3 层插件（改内部）只能改这里登记过名字的点。
 *
 * - 登记：命令和查询（command:<名字>、query:<名字>，commands/registry.ts）、对变化的反应（reaction:<名字>，propagation/registry.ts）、
 *   后台任务的执行体（job:<种类>，services/pipeline.ts）、口径（term:<名字>，readmodel/terms.ts 的 TERM_POINTS）。
 *   只登记内置的；插件自己的命令、任务不是内部点。
 * - 用：调用的地方经 wrap(名字, 原来的函数) 拿到「加上补丁以后」的函数；没有补丁时就是原来那个函数（只查一次表）。
 * - 补丁：patch(名字, 谁, { before, after, around })。多个补丁按加上的顺序叠起来，后加的包在外层，不互相覆盖；
 *   撤掉一个插件的补丁（removeOwner）不影响别的。补丁自己抛的错记在打补丁的插件头上（onPatchError），照样往外抛。
 * - 指纹：点的「样子」——登记的那一层的实现（函数的源码）、输入的格式（命令的 schema、反应订阅的变化……）和手动的版本号，
 *   取 sha256 的前 16 位。插件装上、启用时记下它改的点的指纹；Emaki 更新以后指纹变了，就不加载它、自动停用（domain/plugins/）。
 *   看的只是登记的那一层：更深处（比如命令调用的领域方法）改了看不出来。
 */
import { createHash } from 'node:crypto';

export type PointKind = 'command' | 'query' | 'reaction' | 'job' | 'term';

export const POINT_KINDS: readonly PointKind[] = ['command', 'query', 'reaction', 'job', 'term'];

/** 内部点的名字：<种类>:<名字> */
export const POINT_NAME_RE = /^(command|query|reaction|job|term):\S{1,120}$/;

type Fn = (...args: any[]) => any;

export interface PointSpec {
  kind: PointKind;
  /** 一句人话：「插件」页上、通知里说它改的是什么 */
  label: string;
  /** 输入的格式这类函数源码之外的「样子」（懒算：命令的 JSON Schema 要现转） */
  signature?: () => string;
  /** 行为变了、源码却没变时手动加一（口径这种被别处拼进 SQL 的） */
  version?: number;
}

export interface PatchSpec {
  /** 在原来的之前：可以换参数（返回新的参数数组）；返回 undefined 照旧 */
  before?: (args: unknown[]) => unknown[] | void;
  /** 在原来的之后：可以换结果（返回新的结果）；返回 undefined 照旧。原来的返回 Promise 时等它好了再调 */
  after?: (result: any, args: unknown[]) => unknown;
  /** 包一层：自己决定调不调、怎么调原来的（next） */
  around?: (next: Fn, ...args: any[]) => unknown;
}

export interface PointInfo {
  name: string;
  kind: PointKind;
  label: string;
  /** 加了补丁的插件，按加上的顺序（后面的在外层） */
  owners: string[];
}

interface Point extends PointSpec {
  base: Fn;
  print: string | null;
}

interface Layer {
  owner: string;
  spec: PatchSpec;
}

/** 补丁自己抛的错：照样往外抛，另外记在打补丁的插件头上 */
export type PatchErrorListener = (owner: string, point: string, err: unknown) => void;

export class Points {
  private readonly points = new Map<string, Point>();
  private readonly layers = new Map<string, Layer[]>();
  /** 加了补丁以后的函数（按原来的函数缓存：同一个点不同引擎、不同实例的原函数各算各的） */
  private readonly composed = new Map<string, WeakMap<Fn, Fn>>();
  private readonly errorListeners = new Set<PatchErrorListener>();

  /** 登记一个点；同一个名字再登记就换成新的实现（同一个进程里开了几个引擎时都一样，指纹跟着重算） */
  define(name: string, spec: PointSpec, base: Fn): void {
    if (!POINT_NAME_RE.test(name) || !name.startsWith(`${spec.kind}:`)) throw new Error(`内部点的名字「${name}」不对`);
    this.points.set(name, { ...spec, base, print: null });
  }

  has(name: string): boolean {
    return this.points.has(name);
  }

  /** 一句人话；没登记过的照原名 */
  label(name: string): string {
    return this.points.get(name)?.label ?? name;
  }

  /** 点现在的指纹（没登记过是 null） */
  fingerprint(name: string): string | null {
    const p = this.points.get(name);
    if (!p) return null;
    p.print ??= createHash('sha256')
      .update(`${p.kind}\n${p.version ?? 0}\n${p.signature?.() ?? ''}\n${String(p.base)}`)
      .digest('hex')
      .slice(0, 16);
    return p.print;
  }

  /** 登记过的点（「插件」页、文档用） */
  list(): PointInfo[] {
    return [...this.points].map(([name, p]) => ({ name, kind: p.kind, label: p.label, owners: (this.layers.get(name) ?? []).map((l) => l.owner) }));
  }

  /** 加了补丁的点（「谁改了哪里」；插件状态每次都要算，只走加了补丁的那几个） */
  patched(): PointInfo[] {
    return [...this.layers].flatMap(([name, list]) => {
      const p = this.points.get(name);
      return p && list.length ? [{ name, kind: p.kind, label: p.label, owners: list.map((l) => l.owner) }] : [];
    });
  }

  /** 给一个点加补丁，返回撤掉它的函数 */
  patch(name: string, owner: string, spec: PatchSpec): () => void {
    if (!this.points.has(name)) throw new Error(`没有内部点「${name}」`);
    if (!spec.before && !spec.after && !spec.around) throw new Error(`给「${name}」的补丁什么都没有（before、after、around 至少一个）`);
    for (const [k, v] of Object.entries(spec)) if (v !== undefined && typeof v !== 'function') throw new Error(`补丁的 ${k} 要是函数`);
    const layer: Layer = { owner, spec };
    this.layers.set(name, [...(this.layers.get(name) ?? []), layer]);
    this.composed.delete(name);
    return () => {
      const rest = (this.layers.get(name) ?? []).filter((l) => l !== layer);
      if (rest.length) this.layers.set(name, rest);
      else this.layers.delete(name);
      this.composed.delete(name);
    };
  }

  /** 撤掉一个插件加的全部补丁；返回撤了哪些点 */
  removeOwner(owner: string): string[] {
    const out: string[] = [];
    for (const [name, list] of this.layers) {
      const rest = list.filter((l) => l.owner !== owner);
      if (rest.length === list.length) continue;
      out.push(name);
      if (rest.length) this.layers.set(name, rest);
      else this.layers.delete(name);
      this.composed.delete(name);
    }
    return out;
  }

  onPatchError(fn: PatchErrorListener): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  /** 原来的函数加上补丁以后的样子；没有补丁就是它自己 */
  wrap<F extends Fn>(name: string, base: F): F {
    const list = this.layers.get(name);
    if (!list?.length) return base;
    let cache = this.composed.get(name);
    if (!cache) this.composed.set(name, (cache = new WeakMap()));
    let fn = cache.get(base);
    if (!fn) {
      fn = list.reduce<Fn>((inner, l) => this.layer(name, inner, l), base);
      cache.set(base, fn);
    }
    return fn as F;
  }

  private layer(name: string, inner: Fn, { owner, spec }: Layer): Fn {
    const points = this;
    /** 里层（原来的、或者先加的补丁）抛的错：不记在这个插件头上 */
    const fromInner = new WeakSet<object>();
    const mark = (e: unknown) => {
      if (e && typeof e === 'object') fromInner.add(e);
      return e;
    };
    const blame = (e: unknown) => {
      if (!(e && typeof e === 'object' && fromInner.has(e))) for (const l of points.errorListeners) l(owner, name, e);
      return e;
    };
    return function patched(this: unknown, ...args: unknown[]) {
      const self = this;
      const next = (...a: unknown[]) => {
        try {
          const r = inner.apply(self, a);
          return r instanceof Promise ? r.catch((e: unknown) => Promise.reject(mark(e))) : r;
        } catch (e) {
          throw mark(e);
        }
      };
      try {
        let a = args;
        if (spec.before) {
          const b = spec.before(a);
          if (Array.isArray(b)) a = b;
        }
        const out = spec.around ? spec.around(next, ...a) : next(...a);
        if (!spec.after) return out instanceof Promise ? out.catch((e: unknown) => Promise.reject(blame(e))) : out;
        const after = (r: unknown) => {
          const x = spec.after!(r, a);
          return x === undefined ? r : x;
        };
        return out instanceof Promise ? out.then(after).catch((e: unknown) => Promise.reject(blame(e))) : after(out);
      } catch (e) {
        throw blame(e);
      }
    };
  }
}
