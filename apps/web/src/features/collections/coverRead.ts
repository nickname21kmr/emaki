import type { ID } from '@emaki/shared';

/**
 * 扉页上点封面去读（本子的书、组图的扇形封面）：读过（进度大于 1）就接着那一页，没读过、只看了第 1 页都从第 1 页开始。
 * 地址和页头的「继续读 / 从头读」是同一种写法（阅读器按 ?p= 打开）。
 */
export function coverRead(id: ID, progress: number | null, unit: '页' | '张'): { href: string; label: string } {
  const page = progress && progress > 1 ? progress : 1;
  return { href: `/collections/${id}/read?p=${page}`, label: page > 1 ? `继续读 · 第 ${page} ${unit}` : '从头读' };
}
