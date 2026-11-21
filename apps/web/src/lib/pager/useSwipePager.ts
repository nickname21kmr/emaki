/**
 * 触屏的一根手指左右滑翻一张（lib/pager 的底层件）：跟手移动「跟手层」（layerRef），过阈值翻、没过弹回，到头有阻尼。
 * 只认 pointerType === 'touch'；方向锁定、阈值、速度的判定都在 lib/gestures.ts。
 *
 * - 给了 settle 时翻页的动画交给调用方（usePager：轨道从手指停的位置接着滑到下一张）；
 *   不给时往手指的方向滑出去一点再换（「未识别」的大图：换图的动画在 PreviewStage 里）。
 * - 竖着的拖动：给了 vertical 就归它（看图器的下滑关闭、上滑展开信息），不给就交给浏览器滚动。
 * - 点按不归这里：放大、双击、单击切换界面都在 useTouchZoom（只有一处认点按）。
 * rtl（本子右开）时方向反过来：往右滑是下一页。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { lockAxis, pushSample, swipeDecision, swipeOffset, velocityOf, type Sample } from '../gestures';

/** 松手时往哪翻：forward = 下一页，back = 上一页，null = 弹回。rtl 时手指往右是下一页；hasNext 默认有 */
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

/** 竖着拖：move 跟手，end 松手（vy px/ms，往下为正），cancel 被打断（换成捏合、浏览器接手） */
export interface VerticalDrag {
  move: (dx: number, dy: number) => void;
  end: (dy: number, vy: number) => void;
  cancel: () => void;
}

export function useSwipePager(o: {
  hasPrev: boolean;
  hasNext?: boolean;
  rtl?: boolean;
  /** 不跟手（比如放大着、正在关闭） */
  disabled?: boolean;
  onForward: () => void;
  onBack: () => void;
  settle?: (go: 'forward' | 'back') => void;
  vertical?: VerticalDrag;
}) {
  const opts = useRef(o);
  opts.current = o;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const s = useRef<{ start: Sample; samples: Sample[]; axis: 'x' | 'y' | null; dx: number; dy: number; width: number } | null>(null);
  const touchedAt = useRef(0);

  const setLayer = (x: number, ms = 0) => {
    const el = layerRef.current;
    if (!el) return;
    el.style.transition = ms ? `translate ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.translate = x ? `${x}px 0` : '';
  };

  /** 打断：横着的弹回，竖着的交给 vertical.cancel */
  const cancel = () => {
    const g = s.current;
    s.current = null;
    if (g?.axis === 'x') setLayer(0, 220);
    else if (g?.axis === 'y') opts.current.vertical?.cancel();
  };

  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch' || !e.isPrimary || opts.current.disabled) return;
      touchedAt.current = performance.now();
      // 按钮上的按下（两侧翻页热区、模糊图上的「显示」）：点按照常是按钮自己的 click；滑动照样翻页
      const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      s.current = { start: p, samples: [p], axis: null, dx: 0, dy: 0, width: e.currentTarget.clientWidth };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const g = s.current;
      if (!g || e.pointerType !== 'touch') return;
      g.dx = e.clientX - g.start.x;
      g.dy = e.clientY - g.start.y;
      g.samples = pushSample(g.samples, { x: e.clientX, y: e.clientY, t: e.timeStamp });
      const O = opts.current;
      if (!g.axis) {
        const axis = lockAxis(g.dx, g.dy);
        if (!axis || (axis === 'y' && !O.vertical)) return;
        g.axis = axis;
        // 认定方向以后才抓住指针：点按时让两侧热区按钮自己收到 click
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      if (g.axis === 'y') return O.vertical?.move(g.dx, g.dy);
      const k = O.rtl ? -1 : 1;
      setLayer(k * swipeOffset(g.dx * k, { hasPrev: O.hasPrev, hasNext: O.hasNext ?? true }));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const g = s.current;
      s.current = null;
      if (!g || e.pointerType !== 'touch') return;
      touchedAt.current = performance.now();
      const O = opts.current;
      const { vx, vy } = velocityOf(g.samples);
      if (g.axis === 'y') return O.vertical?.end(g.dy, vy);
      if (g.axis !== 'x') return;
      const go = swipePagerDecision({ dx: g.dx, vx, width: g.width, rtl: !!O.rtl, hasPrev: O.hasPrev, hasNext: O.hasNext });
      if (!go) return void setLayer(0, 220);
      if (O.settle) return O.settle(go);
      // 往手指的方向滑出去一点再换页（新的一张由调用方自己的动画进来）
      setLayer(Math.sign(g.dx) * g.width * 0.6, 140);
      window.setTimeout(() => {
        if (go === 'forward') opts.current.onForward();
        else opts.current.onBack();
        setLayer(0);
      }, 130);
    },
    // 浏览器接手竖着滚动时会发 pointercancel：弹回
    onPointerCancel: () => cancel(),
  };

  return { handlers, layerRef, cancel, fromTouch: () => performance.now() - touchedAt.current < 700 };
}
