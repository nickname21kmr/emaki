/**
 * 左右滑翻一页（A1）：阅读器翻页、未识别里跳过 / 上一张。跟手移动「跟手层」（layerRef），过阈值翻、没过弹回，第一页再往回有阻尼；
 * 没滑动的点按（不在按钮上）交给 onCenterTap（阅读器：切换顶栏和胶片条）。按钮上的点按照常是按钮自己的 click。
 * 给了 settle 时翻页的动画交给调用方（阅读器的轨道：相邻的一开跟着露出来、松手顺势滑到位）。
 * rtl（本子右开）时方向反过来：往右滑是下一页。只认 pointerType === 'touch'，竖着的滑动交给浏览器滚动；判定都在 lib/gestures.ts。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { isTap, lockAxis, pushSample, swipeDecision, swipeOffset, velocityOf, type Sample } from './gestures';

/** 松手时往哪翻：forward = 下一页，back = 上一页，null = 弹回。rtl 时手指往右是下一页；hasNext 默认有（阅读器最后一开后面是结尾卡） */
export function swipePagerDecision(p: {
  dx: number;
  vx: number;
  width: number;
  rtl: boolean;
  hasPrev: boolean;
  hasNext?: boolean;
}): 'forward' | 'back' | null {
  const k = p.rtl ? -1 : 1;
  const go = swipeDecision({ dx: p.dx * k, vx: p.vx * k, width: p.width, hasPrev: p.hasPrev, hasNext: p.hasNext ?? true });
  return go === 1 ? 'forward' : go === -1 ? 'back' : null;
}

export function useSwipePager(o: {
  hasPrev: boolean;
  hasNext?: boolean;
  rtl?: boolean;
  onForward: () => void;
  onBack: () => void;
  onCenterTap?: () => void;
  /**
   * 松手决定翻页时由调用方接着动（阅读器：轨道从手指停的位置滑到下一开，lib/usePageTrack.ts，位移它自己从跟手层上读）。
   * 不给时照旧：往手指的方向滑出去一点再换页。
   */
  settle?: (go: 'forward' | 'back') => void;
}) {
  const opts = useRef(o);
  opts.current = o;
  const layerRef = useRef<HTMLDivElement>(null);
  const s = useRef<{ start: Sample; samples: Sample[]; swiping: boolean; onButton: boolean; dx: number; dy: number; width: number } | null>(null);
  const touchedAt = useRef(0);

  const setLayer = (x: number, ms = 0) => {
    const el = layerRef.current;
    if (!el) return;
    el.style.transition = ms ? `translate ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.translate = x ? `${x}px 0` : '';
  };

  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      touchedAt.current = performance.now();
      const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      const onButton = !!(e.target as Element).closest('button');
      s.current = { start: p, samples: [p], swiping: false, onButton, dx: 0, dy: 0, width: e.currentTarget.clientWidth };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const g = s.current;
      if (!g || e.pointerType !== 'touch') return;
      g.dx = e.clientX - g.start.x;
      g.dy = e.clientY - g.start.y;
      g.samples = pushSample(g.samples, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      if (!g.swiping && lockAxis(g.dx, g.dy) === 'x') {
        g.swiping = true;
        // 认定是滑动以后才抓住指针：点按时让两侧热区按钮自己收到 click
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (!g.swiping) return;
      const { rtl, hasPrev, hasNext = true } = opts.current;
      const k = rtl ? -1 : 1;
      setLayer(k * swipeOffset(g.dx * k, { hasPrev, hasNext }));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const g = s.current;
      s.current = null;
      if (!g || e.pointerType !== 'touch') return;
      touchedAt.current = performance.now();
      const O = opts.current;
      if (!g.swiping) {
        if (!g.onButton && isTap(e.timeStamp - g.start.t, Math.hypot(g.dx, g.dy))) O.onCenterTap?.();
        return;
      }
      const go = swipePagerDecision({ dx: g.dx, vx: velocityOf(g.samples).vx, width: g.width, rtl: !!O.rtl, hasPrev: O.hasPrev, hasNext: O.hasNext });
      if (!go) return void setLayer(0, 220);
      if (O.settle) return O.settle(go);
      // 往手指的方向滑出去一点再换页（新的一页淡入）
      setLayer(Math.sign(g.dx) * g.width * 0.6, 140);
      window.setTimeout(() => {
        if (go === 'forward') opts.current.onForward();
        else opts.current.onBack();
        setLayer(0);
      }, 130);
    },
    // 浏览器接手竖着滚动时会发 pointercancel：弹回
    onPointerCancel: () => {
      if (s.current?.swiping) setLayer(0, 220);
      s.current = null;
    },
  };

  return { handlers, layerRef, fromTouch: () => performance.now() - touchedAt.current < 700 };
}
