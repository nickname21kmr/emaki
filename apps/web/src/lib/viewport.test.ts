import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BREAKPOINTS,
  cardMinWidth,
  gridGap,
  gridRowHeight,
  heightClass,
  isNarrow,
  readerSpreadFits,
  stagePadding,
  stickyHeaderFits,
  viewportOf,
  widthClass,
} from './viewport';

// A1 的窗口分级（docs/FRONTEND.md「窗口分级」）：手机、平板、电脑是同一套页面，按窗口尺寸和输入方式排。

/** spec 第 4 节的测试矩阵 + 电脑 */
const PHONE = viewportOf(390, 844, true);
const PHONE_LAND = viewportOf(844, 390, true);
const TABLET = viewportOf(800, 1280, true);
const TABLET_LAND = viewportOf(1280, 800, true);
const DESKTOP = viewportOf(1440, 900, false);

describe('窗口分级', () => {
  it('宽度：< 600 compact，600–839 medium，≥ 840 expanded；高度 < 480 是 compact', () => {
    expect([599, 600, 839, 840].map(widthClass)).toEqual(['compact', 'medium', 'medium', 'expanded']);
    expect([479, 480].map(heightClass)).toEqual(['compact', 'regular']);
  });

  it('测试矩阵里的设备各落在哪一级；触屏和尺寸无关（平板横屏是 expanded，但它是触屏）', () => {
    const cls = (v: typeof PHONE) => [v.width, v.height, v.orientation, v.touch];
    expect(cls(PHONE)).toEqual(['compact', 'regular', 'portrait', true]);
    expect(cls(PHONE_LAND)).toEqual(['expanded', 'compact', 'landscape', true]);
    expect(cls(TABLET)).toEqual(['medium', 'regular', 'portrait', true]);
    expect(cls(TABLET_LAND)).toEqual(['expanded', 'regular', 'landscape', true]);
    expect(cls(DESKTOP)).toEqual(['expanded', 'regular', 'landscape', false]);
    expect([PHONE, TABLET, TABLET_LAND, DESKTOP].map(isNarrow)).toEqual([true, true, false, false]);
  });

  it('CSS 变体（styles/index.css）和这里的断点是同一组数', () => {
    const css = readFileSync(path.resolve(import.meta.dirname, '../styles/index.css'), 'utf8');
    const variant = (name: string) => css.match(new RegExp(`@custom-variant ${name} \\((.+)\\);`))?.[1];
    expect(variant('compact')).toBe(`@media (width < ${BREAKPOINTS.medium}px)`);
    expect(variant('medium')).toBe(`@media (${BREAKPOINTS.medium}px <= width < ${BREAKPOINTS.expanded}px)`);
    expect(variant('narrow')).toBe(`@media (width < ${BREAKPOINTS.expanded}px)`);
    expect(variant('short')).toBe(`@media (height < ${BREAKPOINTS.short}px)`);
    expect(variant('touch')).toBe('@media (pointer: coarse)');
    // compact 定义在 narrow 后面：同一属性上 compact: 盖过 narrow:
    expect(css.indexOf('@custom-variant compact')).toBeGreaterThan(css.indexOf('@custom-variant narrow'));
  });
});

describe('排法的规则', () => {
  it('网格目标行高按宽度缩放：手机竖屏 160、平板竖屏 220、手机横屏最多 160；电脑照用户的设置', () => {
    expect(gridRowHeight(PHONE, 240)).toBe(160);
    expect(gridRowHeight(TABLET, 240)).toBe(220);
    expect(gridRowHeight(PHONE_LAND, 240)).toBe(160);
    expect(gridRowHeight(TABLET_LAND, 240)).toBe(240);
    // 电脑：密度设置、行高滑块原样生效（不变）
    for (const pref of [120, 180, 240, 400]) expect(gridRowHeight(DESKTOP, pref)).toBe(pref);
    // 用户调得更小时照用户的
    expect(gridRowHeight(PHONE, 120)).toBe(120);
    expect(gridGap(PHONE)).toBe(4);
    expect(gridGap(DESKTOP)).toBe(6);
  });

  it('手机竖屏上一行大约 2–3 张竖图（插画常见的 0.7），平板竖屏 3–4 张', () => {
    // 内容宽：手机 390 - 两边 16；平板 800 - 侧栏 76 - 纸边 8 - 两边 20
    const perRow = (width: number, h: number, gap: number) => (width + gap) / (0.7 * h + gap);
    expect(perRow(358, gridRowHeight(PHONE, 240), 4)).toBeGreaterThanOrEqual(2);
    expect(perRow(358, gridRowHeight(PHONE, 240), 4)).toBeLessThanOrEqual(3.3);
    expect(perRow(676, gridRowHeight(TABLET, 240), 6)).toBeGreaterThanOrEqual(3);
    expect(perRow(676, gridRowHeight(TABLET, 240), 6)).toBeLessThanOrEqual(4.5);
  });

  it('卡片网格：手机竖屏上最小卡宽收到 8 成，别的不变', () => {
    expect(cardMinWidth(PHONE, 176)).toBe(141);
    expect(cardMinWidth(TABLET, 176)).toBe(176);
    expect(cardMinWidth(DESKTOP, 176)).toBe(176);
  });

  it('看图器的留白：电脑上给箭头留 84 / 68（不变），触屏宽屏收窄，窄屏铺满宽度', () => {
    expect(stagePadding(DESKTOP)).toEqual({ x: 84, y: 68 });
    expect(stagePadding(TABLET_LAND)).toEqual({ x: 24, y: 64 });
    expect(stagePadding(PHONE)).toEqual({ x: 0, y: 56 });
    expect(stagePadding(TABLET)).toEqual({ x: 0, y: 56 });
  });

  it('阅读器横屏而且够宽才双页；页头在手机横屏不吸顶', () => {
    expect([PHONE, PHONE_LAND, TABLET, TABLET_LAND, DESKTOP].map(readerSpreadFits)).toEqual([false, true, false, true, true]);
    // 窄的电脑窗口：竖着的单页；电脑上 840–1099 宽的窗口照原来的规则也是单页，1100 起双页
    expect(readerSpreadFits(viewportOf(820, 900, false))).toBe(false);
    expect(readerSpreadFits(viewportOf(1000, 700, false))).toBe(false);
    expect(readerSpreadFits(viewportOf(1100, 700, false))).toBe(true);
    // 触屏横屏够 expanded 就双页（平板横屏 1000 宽也是）
    expect(readerSpreadFits(viewportOf(1000, 700, true))).toBe(true);
    expect([PHONE, PHONE_LAND, TABLET, DESKTOP].map(stickyHeaderFits)).toEqual([true, false, true, true]);
  });
});

describe('规则集中在一处', () => {
  const SRC = path.resolve(import.meta.dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  // 按窗口宽高、指针类型做排法判断的写法：innerWidth / innerHeight 和数比较、宽高 / 指针的媒体查询
  const LAYOUT_BY_SIZE = /inner(Width|Height)\s*[<>]=?\s*\d|matchMedia\(\s*['"`]\((min-|max-)?(width|height)|matchMedia\(\s*['"`]\((any-)?(pointer|hover)/;
  // 助手附页按窗口宽度排成并排 / 覆盖 / 底页，是它自己的一套（docs/FRONTEND.md「附页：助手」），先不搬
  const ALLOWED = new Set(['lib/viewport.ts', 'features/assistant/dock.ts']);

  it('组件里不各自按窗口尺寸、指针类型分支：都从 lib/viewport.ts 取（或者写成 CSS 变体）', () => {
    const offenders = sources(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel) && LAYOUT_BY_SIZE.test(readFileSync(path.join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
