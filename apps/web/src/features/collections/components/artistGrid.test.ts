import { describe, expect, it } from 'vitest';
import { ARTIST_GRID, artistGridLayout } from './artistGrid';

// 画师网格按行虚拟化以后列数、卡宽自己算：要和原来的 CSS 网格
// grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-7 排出来的一样。
// 下面的宽度是改之前在真实库上量到的容器宽度和列数 / 卡宽（窗口 2560、1440、1100、860、700、375）。
const MEASURED = [
  { width: 2412, cols: 14, cardWidth: 153.71 },
  { width: 1292, cols: 7, cardWidth: 167.43 },
  { width: 952, cols: 5, cardWidth: 174.4 },
  { width: 712, cols: 4, cardWidth: 163 },
  { width: 576, cols: 3, cardWidth: 178.67 },
  { width: 343, cols: 2, cardWidth: 161.5 },
];

describe('artistGridLayout：照原来的 CSS 网格算', () => {
  it('列数、卡宽和改之前量到的一样', () => {
    for (const m of MEASURED) {
      const g = artistGridLayout(m.width);
      expect(g.cols, `宽 ${m.width}`).toBe(m.cols);
      expect(g.cardWidth, `宽 ${m.width}`).toBeCloseTo(m.cardWidth, 1);
    }
  });

  it('卡片高度 = 封面（3:4）+ 两行图注；1440 宽的窗口里一张 269.5 上下', () => {
    const g = artistGridLayout(1292);
    expect(g.cardHeight).toBeCloseTo((1292 - 6 * 20) / 7 / 0.75 + 46.25, 6);
    expect(g.cardHeight).toBeCloseTo(269.5, 1);
    // 2,640 位、7 列：378 行，整节的高度和改之前量到的 112,427 只差几个像素（差在亚像素取整，组件挂上后按真实行高校准）
    const rows = Math.ceil(2640 / g.cols);
    expect(rows).toBe(378);
    expect(Math.abs(rows * g.cardHeight + (rows - 1) * ARTIST_GRID.rowGap - 112_427)).toBeLessThan(6);
  });

  it('放得下「最小宽度 + 间距」才多一列；正好够的那一像素算够', () => {
    // 两列要 150 × 2 + 20 = 320
    expect(artistGridLayout(319).cols).toBe(1);
    expect(artistGridLayout(320).cols).toBe(2);
    expect(artistGridLayout(320).cardWidth).toBe(150);
    expect(artistGridLayout(489).cols).toBe(2);
    expect(artistGridLayout(490).cols).toBe(3);
  });

  it('还没量到宽度（0）、比一张卡还窄：一列，卡宽不小于最小宽度', () => {
    for (const width of [0, 100, 149]) {
      const g = artistGridLayout(width);
      expect(g.cols).toBe(1);
      expect(g.cardWidth).toBe(ARTIST_GRID.minWidth);
    }
    // 一列时卡片占满整行
    expect(artistGridLayout(300).cardWidth).toBe(300);
  });
});
