/**
 * 网页的内部点（@emaki/shared 的 WEB_POINTS，docs/plugins.md 第 7 节）在服务端的登记：补丁在网页上加，这里只为了查有没有、算指纹。
 * 指纹按约定算（core/pointContracts.ts：组件的 props、函数的签名和版本号，scripts/pointContracts.ts 从网页的源码里取）：
 * 只改了组件里面的实现，改它的插件照常用。
 */
import { WEB_POINTS, pointKind } from '@emaki/shared';
import type { Points } from '../../core/points.ts';

const NOOP = () => {};

export function defineWebPoints(points: Points): void {
  for (const p of WEB_POINTS) points.define(p.name, { kind: pointKind(p.name)!, label: p.label, version: p.version }, NOOP);
}
