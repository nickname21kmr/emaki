/**
 * 播放器的翻页轨道（usePager 用）：上一张、这一张、下一张并排摆在一条轨道上（每格错开「宽度 + GAP」），翻页就是轨道滑一格。
 *
 * - 先换状态再动（FLIP）：pos 变了 ±1 时，轨道先瞬间挪到「看起来还是刚才那样」的位置（手指停在哪、上一次动画走到哪都接得上），
 *   再滑回 0。按住方向键、连点、滚轮连着翻时，每次都从当前画面接着滑，不排队、不拖慢。
 * - 跳页（胶片条、Home / End、切单双页）和「减少动态效果」直接换，不滑。
 * - 跟手：触屏拖动由 useSwipePager 写同一个元素（layerRef 就是轨道），松手翻页时交给这里（settle）；
 *   触控板左右滑（横向的 wheel，deltaMode 像素）也跟手，过 35% 宽度立刻翻，停下 140ms 后按和触屏同一个阈值决定翻还是弹回。
 * 位移直接写 style.translate，不走 React 状态（每帧重渲染整个播放器太贵）。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { swipeOffset } from '../gestures';
import { swipePagerDecision } from './useSwipePager';

/** 相邻两格之间的空隙（px），和 slotStyle 里的一致 */
export const TRACK_GAP = 24;

/** 第 i 格相对当前格的位置：右开时下一页在左边 */
export const slotStyle = (offset: number, rtl: boolean): React.CSSProperties => ({
  translate: `calc(${rtl ? -offset : offset} * (100% + ${TRACK_GAP}px)) 0`,
});

/** 当前画面上轨道的位移（动画进行中也是实时的值） */
function currentOffset(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).translate) || 0;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 动画时长：离得越远越长一点（点击、按键从一整格开始 ≈ 240ms，拖过一半松手的 ≈ 180ms） */
export function settleMs(fromPx: number, cellPx: number): number {
  const f = cellPx > 0 ? Math.min(1, Math.abs(fromPx) / cellPx) : 1;
  return Math.round(120 + 120 * f);
}

/**
 * pos 变了 ±1 时轨道起步的位移：让刚才那一开留在原来看到的位置。rtl 时轨道方向反过来。
 * 最多一整格（轨道上只摆了前后各一开，再远就没有东西可看了）。
 */
export function startOffset(current: number, delta: number, cellPx: number, rtl: boolean): number {
  const v = current + (rtl ? -1 : 1) * delta * cellPx;
  return Math.max(-cellPx, Math.min(cellPx, v));
}

export function usePageTrack(o: {
  /** 当前格（阅读器：第几开，结尾卡是最后一格） */
  pos: number;
  /** 换了排法（单双页）：格子的意思变了，不滑 */
  layout: unknown;
  rtl: boolean;
  trackRef: RefObject<HTMLDivElement | null>;
}) {
  const last = useRef({ pos: o.pos, layout: o.layout });

  useLayoutEffect(() => {
    const el = o.trackRef.current;
    const prev = last.current;
    last.current = { pos: o.pos, layout: o.layout };
    if (!el || prev.pos === o.pos) return;
    const delta = o.pos - prev.pos;
    const cell = el.clientWidth + TRACK_GAP;
    if (Math.abs(delta) !== 1 || prev.layout !== o.layout || reducedMotion() || !cell) {
      el.style.transition = 'none';
      el.style.translate = '';
      return;
    }
    const from = startOffset(currentOffset(el), delta, cell, o.rtl);
    el.style.transition = 'none';
    el.style.translate = `${from}px 0`;
    void el.offsetWidth; // 先落到起点，再开始过渡
    el.style.transition = `translate ${settleMs(from, cell)}ms var(--ease-out-soft)`;
    el.style.translate = '';
  }, [o.pos, o.layout, o.rtl, o.trackRef]);
}

/**
 * 触控板左右滑（横向 wheel）跟手翻页。返回 true 表示这次 wheel 归它（调用方就别再按竖向滚轮翻页了）。
 * 鼠标滚轮（一格一格、竖向）不归这里：一格翻一页，动画和点击一样。
 */
export function useTrackpadPager(o: {
  trackRef: RefObject<HTMLDivElement | null>;
  rtl: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  disabled?: boolean;
  onForward: () => void;
  onBack: () => void;
}) {
  const opts = useRef(o);
  opts.current = o;
  const s = useRef({ dx: 0, timer: 0, quietUntil: 0 });

  const move = (x: number, ms = 0) => {
    const el = opts.current.trackRef.current;
    if (!el) return;
    el.style.transition = ms ? `translate ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.translate = x ? `${x}px 0` : '';
  };

  const finish = (force: boolean) => {
    const g = s.current;
    const O = opts.current;
    window.clearTimeout(g.timer);
    const width = O.trackRef.current?.clientWidth ?? 0;
    const go = force
      ? g.dx * (O.rtl ? -1 : 1) < 0
        ? 'forward'
        : 'back'
      : swipePagerDecision({ dx: g.dx, vx: 0, width, rtl: O.rtl, hasPrev: O.hasPrev, hasNext: O.hasNext });
    g.dx = 0;
    if (!go) return move(0, 220);
    // 翻过以后惯性还会送来一串 wheel：安静 200ms 之前都不理
    g.quietUntil = performance.now() + 200;
    if (go === 'forward') O.onForward();
    else O.onBack();
  };

  return (e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): boolean => {
    const O = opts.current;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.deltaMode !== 0) return false;
    if (O.disabled) return true;
    const g = s.current;
    const now = performance.now();
    if (now < g.quietUntil) {
      g.quietUntil = now + 200;
      return true;
    }
    g.dx -= e.deltaX;
    const k = O.rtl ? -1 : 1;
    const dx = k * swipeOffset(g.dx * k, { hasPrev: O.hasPrev, hasNext: O.hasNext });
    move(dx);
    const width = O.trackRef.current?.clientWidth ?? 0;
    const blocked = dx !== g.dx; // 到头了（有阻尼）：只弹回，不翻
    window.clearTimeout(g.timer);
    if (!blocked && width && Math.abs(g.dx) >= width * 0.35) finish(true);
    else g.timer = window.setTimeout(() => finish(false), 140);
    return true;
  };
}
