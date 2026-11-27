/**
 * 内部点（docs/plugins.md 第 7 节，E6）：第 3 层插件（改内部）只能改这里登记过名字的点。
 *
 * - 登记：命令和查询（command:<名字>、query:<名字>，commands/registry.ts）、对变化的反应（reaction:<名字>，propagation/registry.ts）、
 *   后台任务的执行体（job:<种类>，services/pipeline.ts）、口径（term:<名字>，readmodel/terms.ts 的 TERM_POINTS）。
 *   只登记内置的；插件自己的命令、任务不是内部点。
 *   网页的点（component:、fn:，@emaki/shared 的 WEB_POINTS）也登记在这里，只为了查有没有、算指纹（services/plugins/webPoints.ts）；
 *   补丁在网页上加（apps/web/src/lib/points.tsx），这里不能给它们加。
 * - 用：调用的地方经 wrap(名字, 原来的函数) 拿到「加上补丁以后」的函数；没有补丁时就是原来那个函数（只查一次表）。
 * - 补丁怎么叠、撤、出错算谁的：@emaki/shared 的 PatchStack（网页同一份）。
 * - 指纹：只按点的约定（core/pointContracts.ts：命令的输入格式、组件的 props、函数的签名、版本号……，记在 pointContracts.json）算，
 *   取 sha256 的前 16 位：只改了实现、约定没变，改它的插件照常用。插件装上、启用时记下它改的点的指纹；约定变了就不加载它、自动停用
 *   （domain/plugins/）。约定里没有的点（新加了还没更新那份文件，测试会拦）退回按实现算。
 */
import { isWebPoint, PatchStack, POINT_NAME_RE, type PointKind } from '@emaki/shared';
import { createHash } from 'node:crypto';
import { pointContracts } from './pointContracts.ts';

export { POINT_NAME_RE, type PatchSpec, type PointKind } from '@emaki/shared';

type Fn = (...args: any[]) => any;

export interface PointSpec {
  kind: PointKind;
  /** 一句人话：「插件」页上、通知里说它改的是什么 */
  label: string;
  /** 约定（测试里模拟约定变了用；平时从 pointContracts.json 取） */
  contract?: readonly string[];
  /** 约定里没有这个点时，指纹按它和实现算（懒算） */
  signature?: () => string;
  /** 行为变了、源码却没变时手动加一（口径这种被别处拼进 SQL 的） */
  version?: number;
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

/**
 * 指纹的算法版本，写在指纹前面（c1：只按约定算，12.11）。以后再换算法就换前缀：记下的指纹前缀不一样，说明是旧算法算的，
 * 不能拿来比——不当成「点变了」，加载时按新算法悄悄重记（domain/plugins/ 的 pointsChanged、upgradePrints）
 */
export const PRINT_SCHEME = 'c1:';

export class Points extends PatchStack {
  private readonly points = new Map<string, Point>();

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
    const contract = p.contract ?? pointContracts()[name];
    p.print ??= PRINT_SCHEME + createHash('sha256')
      .update(contract ? `${name}\n${contract.join('\n')}` : `${p.kind}\n${p.version ?? 0}\n${p.signature?.() ?? ''}\n${String(p.base)}`)
      .digest('hex')
      .slice(0, 16);
    return p.print;
  }

  /** 登记过的点（「插件」页、文档用） */
  list(): PointInfo[] {
    return [...this.points].map(([name, p]) => ({ name, kind: p.kind, label: p.label, owners: this.layersOf(name).map((l) => l.owner) }));
  }

  /** 加了补丁的点（「谁改了哪里」；插件状态每次都要算，只走加了补丁的那几个） */
  patched(): PointInfo[] {
    return this.patchedNames().flatMap(({ name, owners }) => {
      const p = this.points.get(name);
      return p ? [{ name, kind: p.kind, label: p.label, owners }] : [];
    });
  }

  protected override check(name: string): void {
    if (!this.points.has(name)) throw new Error(`没有内部点「${name}」`);
    if (isWebPoint(name)) throw new Error(`「${name}」在网页上，要在插件的 web 入口里改`);
  }
}
