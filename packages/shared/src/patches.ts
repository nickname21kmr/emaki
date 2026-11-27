/**
 * 改内部的补丁怎么叠（docs/plugins.md 第 7 节，E6）：服务端的内部点（apps/server/src/core/points.ts）和网页的内部点
 * （apps/web/src/lib/points.tsx）共用这一份。
 *
 * - patch(名字, 谁, { before, after, around })：多个补丁按加上的顺序叠起来，后加的包在外层，不互相覆盖；返回撤掉它的函数。
 * - removeOwner(谁)：撤掉一个插件加的全部补丁，不影响别的。
 * - wrap(名字, 原来的函数)：加上补丁以后的函数；没有补丁就是它自己（只查一次表）。
 * - 补丁自己抛的错（before、after、around 里的）记在打补丁的插件头上（onPatchError），照样往外抛；里层抛的不算它的。
 * - 补丁变了（加上、撤掉）通知 onChange，version 加一（网页按它重画）。
 *
 * 点的名字是 <种类>:<名字>：服务端的 command、query、reaction、job、term，网页的 component、fn（WEB_POINT_KINDS）。
 */

type Fn = (...args: any[]) => any;

/** 服务端的内部点的种类 */
export const SERVER_POINT_KINDS = ['command', 'query', 'reaction', 'job', 'term'] as const;
/** 网页的内部点的种类：组件、函数（登记在 WEB_POINTS） */
export const WEB_POINT_KINDS = ['component', 'fn'] as const;
export type ServerPointKind = (typeof SERVER_POINT_KINDS)[number];
export type WebPointKind = (typeof WEB_POINT_KINDS)[number];
export type PointKind = ServerPointKind | WebPointKind;

/** 内部点的名字：<种类>:<名字> */
export const POINT_NAME_RE = /^(command|query|reaction|job|term|component|fn):\S{1,120}$/;

export const pointKind = (name: string): PointKind | null => (POINT_NAME_RE.test(name) ? (name.slice(0, name.indexOf(':')) as PointKind) : null);
/** 这个点在网页上（组件、函数），不在服务端 */
export const isWebPoint = (name: string): boolean => (WEB_POINT_KINDS as readonly string[]).includes(pointKind(name) ?? '');

export interface PatchSpec {
  /** 在原来的之前：可以换参数（返回新的参数数组）；返回 undefined 照旧 */
  before?: (args: unknown[]) => unknown[] | void;
  /** 在原来的之后：可以换结果（返回新的结果）；返回 undefined 照旧。原来的返回 Promise 时等它好了再调 */
  after?: (result: any, args: unknown[]) => unknown;
  /** 包一层：自己决定调不调、怎么调原来的（next） */
  around?: (next: Fn, ...args: any[]) => unknown;
}

export interface PatchLayer {
  owner: string;
  spec: PatchSpec;
}

/** 补丁自己抛的错：照样往外抛，另外记在打补丁的插件头上 */
export type PatchErrorListener = (owner: string, point: string, err: unknown) => void;

export class PatchStack {
  protected readonly layers = new Map<string, PatchLayer[]>();
  /** 加了补丁以后的函数（按原来的函数缓存：同一个点不同实例的原函数各算各的） */
  private readonly composed = new Map<string, WeakMap<Fn, Fn>>();
  private readonly errorListeners = new Set<PatchErrorListener>();
  private readonly changeListeners = new Set<() => void>();
  private ver = 0;

  /** 能不能给这个点加补丁（子类查登记过没有）；不能就抛错 */
  protected check(_name: string): void {}

  /** 给一个点加补丁，返回撤掉它的函数 */
  patch(name: string, owner: string, spec: PatchSpec): () => void {
    this.check(name);
    if (!spec || (!spec.before && !spec.after && !spec.around)) throw new Error(`给「${name}」的补丁什么都没有（before、after、around 至少一个）`);
    for (const [k, v] of Object.entries(spec)) if (v !== undefined && typeof v !== 'function') throw new Error(`补丁的 ${k} 要是函数`);
    const layer: PatchLayer = { owner, spec };
    this.layers.set(name, [...(this.layers.get(name) ?? []), layer]);
    this.changed(name);
    return () => {
      const list = this.layers.get(name) ?? [];
      if (!list.includes(layer)) return;
      const rest = list.filter((l) => l !== layer);
      if (rest.length) this.layers.set(name, rest);
      else this.layers.delete(name);
      this.changed(name);
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
    if (out.length) this.bump();
    return out;
  }

  /** 加在这个点上的补丁（按加上的顺序，后面的在外层） */
  layersOf(name: string): readonly PatchLayer[] {
    return this.layers.get(name) ?? [];
  }

  /** 加了补丁的点和改它的插件 */
  patchedNames(): { name: string; owners: string[] }[] {
    return [...this.layers].filter(([, l]) => l.length).map(([name, l]) => ({ name, owners: l.map((x) => x.owner) }));
  }

  onPatchError(fn: PatchErrorListener): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  /** 补丁变了（加上、撤掉） */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** 补丁每变一次加一 */
  get version(): number {
    return this.ver;
  }

  /** 把一个错记在打补丁的插件头上（网页上组件的补丁在渲染时出错，由错误边界报过来） */
  reportError(owner: string, point: string, err: unknown): void {
    for (const l of this.errorListeners) l(owner, point, err);
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

  private changed(name: string): void {
    this.composed.delete(name);
    this.bump();
  }

  private bump(): void {
    this.ver++;
    for (const l of this.changeListeners) l();
  }

  private layer(name: string, inner: Fn, { owner, spec }: PatchLayer): Fn {
    /** 里层（原来的、或者先加的补丁）抛的错：不记在这个插件头上 */
    const fromInner = new WeakSet<object>();
    const mark = (e: unknown) => {
      if (e && typeof e === 'object') fromInner.add(e);
      return e;
    };
    const blame = (e: unknown) => {
      if (!(e && typeof e === 'object' && fromInner.has(e))) this.reportError(owner, name, e);
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
