/**
 * 窗口分级和输入方式（docs/FRONTEND.md「窗口分级」，A1）：手机、平板、电脑是同一套页面，按窗口大小和输入方式排。
 * 判断依据只有两样：窗口尺寸、主要的指针是不是触屏；不判断「是不是手机」「是不是 App」。
 *
 * 分级参照 Material 的窗口尺寸等级：
 *   宽度 compact < 600（手机竖屏）· medium 600–839（平板竖屏、小平板）· expanded ≥ 840（平板横屏、电脑、手机横屏）
 *   高度 compact < 480（手机横屏）
 *   输入 touch = (pointer: coarse)；hover = (hover: hover)。和尺寸无关：平板横屏宽度是 expanded，但它是触屏
 *
 * CSS 里用同样的断点写成 Tailwind 变体（styles/index.css）：compact: medium: narrow:（compact + medium）short: touch:。
 * 能用变体解决的不用这里；要在 JS 里算的（网格行高、虚拟列表、看图器留白、阅读器单双页）都从这里取，规则集中在本文件，
 * 组件里不各自写 innerWidth 判断（viewport.test.ts 检查）。
 */
import { useSyncExternalStore } from 'react';

export const BREAKPOINTS = {
  /** 宽度 ≥ 600 是 medium */
  medium: 600,
  /** 宽度 ≥ 840 是 expanded */
  expanded: 840,
  /** 高度 < 480 是高度 compact（手机横屏） */
  short: 480,
} as const;

export type WidthClass = 'compact' | 'medium' | 'expanded';
export type HeightClass = 'compact' | 'regular';

export interface Viewport {
  /** 窗口的 CSS 像素宽高 */
  w: number;
  h: number;
  width: WidthClass;
  height: HeightClass;
  orientation: 'portrait' | 'landscape';
  /** 主要的指针是触屏（pointer: coarse） */
  touch: boolean;
  /** 能悬停（hover: hover）：鼠标、触控板 */
  hover: boolean;
}

export const widthClass = (w: number): WidthClass => (w < BREAKPOINTS.medium ? 'compact' : w < BREAKPOINTS.expanded ? 'medium' : 'expanded');
export const heightClass = (h: number): HeightClass => (h < BREAKPOINTS.short ? 'compact' : 'regular');

export function viewportOf(w: number, h: number, touch: boolean, hover = !touch): Viewport {
  return { w, h, width: widthClass(w), height: heightClass(h), orientation: w > h ? 'landscape' : 'portrait', touch, hover };
}

/** 窄：宽度 compact 或 medium（看图器信息面板、多选栏这类「底部面板」的分界） */
export const isNarrow = (v: Viewport) => v.width !== 'expanded';

// ------------------------------------------------------------------ 排法的规则（要在 JS 里算的都在这里）

/**
 * 图片网格（两端对齐行）的目标行高：compact 160、medium 220，手机横屏（高度 compact）最多 160；
 * expanded 用用户的设置（密度、图库的行高滑块）。目标是手机竖屏一行 2–3 张、平板竖屏 3–4 张：
 * 插画多是竖图（约 0.7），按 spec 的 140 / 180 手机上一行 3–4 张、平板竖屏 5 张，所以各往上提了一档。
 * 用户把行高调得比这些还小时照用户的。
 */
export const GRID_ROW_HEIGHT = { compact: 160, medium: 220, short: 160 } as const;

export function gridRowHeight(v: Pick<Viewport, 'width' | 'height'>, preferred: number): number {
  if (v.width === 'compact') return Math.min(preferred, GRID_ROW_HEIGHT.compact);
  if (v.width === 'medium') return Math.min(preferred, GRID_ROW_HEIGHT.medium);
  if (v.height === 'compact') return Math.min(preferred, GRID_ROW_HEIGHT.short);
  return preferred;
}

/**
 * 两端对齐行要不要「平衡」（components/media/justify.ts 的 balance）：窄屏一行只有两三张，
 * 最后挤进来的宽图会把整行压得很矮，平衡后行高更接近目标。宽屏照旧（一行张数多，影响小，电脑上不变）。
 */
export const balancedRows = (v: Pick<Viewport, 'width'>): boolean => v.width !== 'expanded';

/** 卡片网格（别册的截图、漫画页、表情）的最小卡宽：手机竖屏收到 8 成，一行至少两张 */
export const cardMinWidth = (v: Pick<Viewport, 'width'>, min: number): number => (v.width === 'compact' ? Math.round(min * 0.8) : min);

/** 网格的缝：窄屏小一点 */
export const gridGap = (v: Pick<Viewport, 'width'>, preferred = 6): number => (v.width === 'compact' ? Math.min(preferred, 4) : preferred);

/**
 * 看图器「适应窗口」时图片四周的留白（每边）。电脑上左右给切换箭头、上下给顶栏和缩放提示；
 * 触屏没有箭头（左右滑切换），图铺满宽度，顶栏、底部面板浮在图上（像系统相册）。
 */
export function stagePadding(v: Pick<Viewport, 'touch' | 'width'>): { x: number; y: number } {
  if (!v.touch && v.width === 'expanded') return { x: 84, y: 68 };
  if (v.width === 'expanded') return { x: 24, y: 64 };
  return { x: 0, y: 56 };
}

/** 页头吸顶：手机横屏（高度 compact）不吸顶，不然筛选条一吸就占掉小半屏 */
export const stickyHeaderFits = (v: Pick<Viewport, 'height'>): boolean => v.height !== 'compact';

/** 阅读器能不能双页：横屏而且宽度 expanded（竖屏一律单页） */
export const readerSpreadFits = (v: Pick<Viewport, 'width' | 'orientation'>): boolean => v.width === 'expanded' && v.orientation === 'landscape';

// ------------------------------------------------------------------ useViewport

const COARSE = '(pointer: coarse)';
const HOVER = '(hover: hover)';
const SERVER: Viewport = viewportOf(1440, 900, false, true);

let snapshot: Viewport | null = null;

function read(): Viewport {
  const touch = window.matchMedia?.(COARSE).matches ?? false;
  const hover = window.matchMedia?.(HOVER).matches ?? !touch;
  const next = viewportOf(window.innerWidth, window.innerHeight, touch, hover);
  // 值没变就还给同一个对象（useSyncExternalStore 要求快照稳定）
  if (snapshot && snapshot.w === next.w && snapshot.h === next.h && snapshot.touch === next.touch && snapshot.hover === next.hover) return snapshot;
  snapshot = next;
  return next;
}

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  const queries = [COARSE, HOVER].map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m);
  for (const m of queries) m.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
    for (const m of queries) m.removeEventListener('change', onChange);
  };
}

/** 当前窗口的分级（宽度级、高度级、方向、是否触屏）；窗口大小或输入方式变了自动更新 */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, read, () => SERVER);
}

/** 不在组件里时取一次（事件处理里用） */
export const currentViewport = (): Viewport => (typeof window === 'undefined' ? SERVER : read());
