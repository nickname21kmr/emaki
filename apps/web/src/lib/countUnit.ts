/**
 * 排名用的张数后面写的字（内部点 fn:count.unit，docs/plugins.md 第 7 节）：角色、作品、画师的张数（服务端的 term:count.unit 数出来的那些）
 * 后面写什么。内置是「张」；「一个作品算一张」这类改了怎么数的插件可以把它改成「件」，数和字对得上。
 * 图库的总数、文件夹的张数这些不是按它数的，照旧写「张」。
 */
import { patchableFn, usePatches } from './points';

export const countUnit = patchableFn('fn:count.unit', (): string => '张');

/** 组件里用：补丁变了跟着重画 */
export function useCountUnit(): string {
  usePatches();
  return countUnit();
}
