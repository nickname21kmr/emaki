import type { CollectionPage } from '@emaki/shared';

/**
 * 双页排版（T38e）：返回每一「开」的页码。
 * 第 1 页（封面）单独一开；横页（跨页图）单独一开；相邻两张竖页合成一开；最后剩一页就单独一开。
 */
export function buildSpreads(pages: Pick<CollectionPage, 'pageNo' | 'width' | 'height'>[], spread: boolean): number[][] {
  if (!spread) return pages.map((p) => [p.pageNo]);
  const out: number[][] = [];
  const wide = (p: { width: number; height: number }) => p.width > p.height * 1.1;
  let i = 0;
  if (pages[0]) out.push([pages[i++]!.pageNo]);
  while (i < pages.length) {
    const a = pages[i]!;
    const b = pages[i + 1];
    if (wide(a) || !b || wide(b)) {
      out.push([a.pageNo]);
      i += 1;
    } else {
      out.push([a.pageNo, b.pageNo]);
      i += 2;
    }
  }
  return out;
}

/** 包含第 p 页的那一开的下标 */
export const spreadIndexOf = (spreads: number[][], p: number) => Math.max(0, spreads.findIndex((s) => s.includes(p)));
