/**
 * 网页的内部点（docs/plugins.md 第 7 节，E6）：第 3 层插件的 web 入口只能改这里登记过名字的组件和函数（名字在 @emaki/shared 的 WEB_POINTS）。
 *
 * - 组件：`export const Stage = patchable('component:lightbox.Stage', StageImpl)`。补丁 `{ before, after, around }`：
 *   before([props]) 换 props（返回 [新的 props]），around(Next, props) 自己画（用 h(Next, props) 画原来的），after(画出来的, [props]) 换结果。
 *   几个补丁按加上的顺序叠起来，后加的在外层；每层是一个稳定的组件，补丁变了整个换掉（里面的状态重来）。
 *   画的时候出错：这一处退回原来的样子（错误边界），错记在改它的插件头上。
 * - 函数：`export const countUnit = patchableFn('fn:count.unit', () => '张')`；在组件里用时配 usePatches()，补丁变了跟着重画。
 * - 怎么叠、撤、出错算谁的：@emaki/shared 的 PatchStack（服务端同一份）。谁加载插件、给它 internal：features/plugins/internal/。
 */
import { PatchStack, WEB_POINTS, type PatchLayer } from '@emaki/shared';
import { Component, createElement, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from 'react';

const KNOWN: ReadonlyMap<string, (typeof WEB_POINTS)[number]> = new Map(WEB_POINTS.map((p) => [p.name, p]));

class WebPoints extends PatchStack {
  /** patchable / patchableFn 登记过的（WEB_POINTS 里有、网页里也用了） */
  private readonly registered = new Set<string>();
  /** 组件加上补丁以后的样子：按补丁的版本缓存 */
  private readonly components = new Map<string, { version: number; base: ComponentType<any>; comp: ComponentType<any> }>();
  /** 层里自己抛的错（已经记在插件头上，错误边界不再记一次） */
  readonly claimed = new WeakSet<object>();

  register(name: string): void {
    if (!KNOWN.has(name)) throw new Error(`内部点「${name}」没有登记在 WEB_POINTS 里`);
    this.registered.add(name);
  }

  /** 登记过的点（插件的 internal.points()） */
  list(): { name: string; label: string; owners: string[] }[] {
    return [...this.registered].map((name) => ({ name, label: KNOWN.get(name)!.label, owners: this.layersOf(name).map((l) => l.owner) }));
  }

  protected override check(name: string): void {
    if (!KNOWN.has(name)) throw new Error(`没有内部点「${name}」`);
  }

  /** 组件加上补丁以后的样子；没有补丁就是它自己 */
  component<P extends object>(name: string, base: ComponentType<P>): ComponentType<P> {
    const layers = this.layersOf(name);
    if (!layers.length) return base;
    const hit = this.components.get(name);
    if (hit && hit.version === this.version && hit.base === base) return hit.comp;
    const comp = layers.reduce<ComponentType<any>>((inner, l) => this.componentLayer(name, inner, l), base);
    this.components.set(name, { version: this.version, base, comp });
    return comp as ComponentType<P>;
  }

  private componentLayer(name: string, Inner: ComponentType<any>, { owner, spec }: PatchLayer): ComponentType<any> {
    const points = this;
    function PatchLayer(props: object): ReactNode {
      try {
        let p = props;
        if (spec.before) {
          const b = spec.before([props]);
          if (Array.isArray(b) && b[0] && typeof b[0] === 'object') p = b[0] as object;
        }
        const el = spec.around ? (spec.around(Inner as never, p) as ReactNode) : createElement(Inner, p);
        if (!spec.after) return el;
        const x = spec.after(el, [p]);
        return x === undefined ? el : (x as ReactNode);
      } catch (e) {
        if (e && typeof e === 'object') points.claimed.add(e);
        points.reportError(owner, name, e);
        throw e;
      }
    }
    PatchLayer.displayName = `Patch(${name} · ${owner})`;
    return PatchLayer;
  }
}

export const webPoints = new WebPoints();

const subscribe = (fn: () => void) => webPoints.onChange(fn);
const version = () => webPoints.version;

/** 补丁的版本：补丁变了（插件加载、停用）组件跟着重画 */
export function usePatches(): number {
  return useSyncExternalStore(subscribe, version, version);
}

/** 登记一个能改的函数（fn:<名字>）：调的时候按现在的补丁算 */
export function patchableFn<F extends (...args: any[]) => any>(name: `fn:${string}`, base: F): F {
  webPoints.register(name);
  return ((...args: Parameters<F>) => webPoints.wrap(name, base)(...args)) as F;
}

/** 登记一个能改的组件（component:<名字>） */
export function patchable<P extends object>(name: `component:${string}`, Base: ComponentType<P>): ComponentType<P> {
  webPoints.register(name);
  function Patchable(props: P): ReactNode {
    const v = usePatches();
    const Composed = webPoints.component(name, Base);
    if (Composed === Base) return createElement(Base, props);
    // 补丁出错：这一处退回原来的样子；补丁换了（key）再试
    return createElement(PatchBoundary, { key: v, point: name, fallback: () => createElement(Base, props) }, createElement(Composed, props));
  }
  Patchable.displayName = `Patchable(${name})`;
  return Patchable;
}

/** 补丁画的时候出错：退回原来的样子，错记在改这一处的插件头上（层里自己抛的已经记过了） */
export class PatchBoundary extends Component<{ point: string; fallback: () => ReactNode; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (error && typeof error === 'object' && webPoints.claimed.has(error)) return;
    for (const owner of new Set(webPoints.layersOf(this.props.point).map((l) => l.owner))) webPoints.reportError(owner, this.props.point, error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback() : this.props.children;
  }
}
