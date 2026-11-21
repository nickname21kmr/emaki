/**
 * 看图器舞台上的触屏手势（A1）。只处理 pointerType === 'touch'，鼠标、触控笔、键盘照旧走 Stage 原来的逻辑。
 *
 *   1 倍（适应窗口）时：左右滑切上一张 / 下一张（图片跟手，过阈值切、没过弹回，到头有阻尼）；
 *                       下滑关闭（跟手缩小变淡，过阈值放回网格）；上滑展开信息（窄屏的底部面板）
 *   放大后：单指拖动是平移，不切图
 *   双指捏合缩放，以两指中点为中心；双击放大 / 还原；单击切换界面（顶栏、信息面板显示 / 隐藏）
 *
 * 判定（方向锁定、阈值、速度、捏合的数学）都在 lib/gestures.ts，这里只管状态和把位移写到「跟手层」上。
 * 跟手的位移直接写 style，不走 React 状态：每帧重渲染整个舞台太贵。
 */
import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  GESTURE,
  dismissVisual,
  distance,
  dragDecision,
  isDoubleTap,
  isTap,
  lockAxis,
  midpoint,
  pinchZoom,
  pushSample,
  swipeDecision,
  swipeOffset,
  velocityOf,
  type Point,
  type Sample,
} from '@/lib/gestures';
import { clampPan, IDENTITY, type Zoom, type ZoomBounds } from './useZoomPan';

export interface TouchGestureHandlers {
  /** 舞台的状态：每次渲染时更新 */
  zoom: Zoom;
  bounds: ZoomBounds;
  hasPrev: boolean;
  hasNext: boolean;
  setZoom: (next: Zoom | ((prev: Zoom) => Zoom)) => void;
  onPrev: () => void;
  onNext: () => void;
  /** 下滑过了阈值：关掉看图器 */
  onDismiss: () => void;
  /** 下滑过程中的进度（0–1），null = 松手复原：背景和界面跟着变淡 */
  onDismissDrag: (progress: number | null) => void;
  /** 单击：切换界面 */
  onTap: () => void;
  /** 双击（相对舞台中心的坐标） */
  onDoubleTap: (px: number, py: number) => void;
  /** 1 倍时往上滑 */
  onSwipeUp?: () => void;
}

type Mode = 'idle' | 'pending' | 'swipe' | 'dismiss' | 'pan' | 'pinch' | 'none';

export function useTouchGestures(stageRef: RefObject<HTMLDivElement | null>, layerRef: RefObject<HTMLDivElement | null>, h: TouchGestureHandlers) {
  const handlers = useRef(h);
  handlers.current = h;
  const pointers = useRef(new Map<number, Point>());
  const g = useRef<{
    mode: Mode;
    start: Sample;
    z0: Zoom;
    mid0: Point;
    d0: number;
    samples: Sample[];
    dx: number;
    dy: number;
  }>({ mode: 'idle', start: { x: 0, y: 0, t: 0 }, z0: IDENTITY, mid0: { x: 0, y: 0 }, d0: 1, samples: [], dx: 0, dy: 0 });
  const lastTap = useRef<Sample | null>(null);
  const tapTimer = useRef(0);
  /** 最近一次触摸的时间：随后浏览器补发的 click / dblclick 不当成鼠标点击 */
  const touchedAt = useRef(0);

  /** 相对舞台中心的坐标 */
  const toStage = (p: Point): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 } : p;
  };
  const setLayer = (transform: string, ms = 0) => {
    const el = layerRef.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.transform = transform;
  };
  const resetLayer = (ms = 220) => setLayer('', ms);

  const beginPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    if (g.current.mode === 'swipe' || g.current.mode === 'dismiss') {
      resetLayer();
      handlers.current.onDismissDrag(null);
    }
    g.current.mode = 'pinch';
    g.current.z0 = handlers.current.zoom;
    g.current.mid0 = toStage(midpoint(a, b));
    g.current.d0 = distance(a, b);
  };
  const beginSingle = (p: Point, t: number, mode: Mode) => {
    g.current = { ...g.current, mode, start: { ...p, t }, z0: handlers.current.zoom, samples: [{ ...p, t }], dx: 0, dy: 0 };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return false;
    touchedAt.current = performance.now();
    // 按钮（模糊图上的「显示」、还原缩放）自己处理
    if ((e.target as Element).closest('button')) return true;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) beginPinch();
    else if (pointers.current.size === 1) beginSingle({ x: e.clientX, y: e.clientY }, e.timeStamp, 'pending');
    return true;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch' || !pointers.current.has(e.pointerId)) return e.pointerType === 'touch';
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    const H = handlers.current;
    if (s.mode === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return true;
      const z = pinchZoom(s.z0, s.mid0, s.d0, toStage(midpoint(a, b)), distance(a, b), 1, H.bounds.maxScale);
      H.setZoom(clampPan({ ...z, smooth: false }, H.bounds));
      return true;
    }
    const dx = e.clientX - s.start.x;
    const dy = e.clientY - s.start.y;
    s.dx = dx;
    s.dy = dy;
    s.samples = pushSample(s.samples, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (s.mode === 'pending') {
      const axis = lockAxis(dx, dy);
      if (!axis) return true;
      window.clearTimeout(tapTimer.current);
      if (s.z0.scale > 1.001) s.mode = 'pan';
      else if (axis === 'x') s.mode = 'swipe';
      else s.mode = dy > 0 ? 'dismiss' : 'none';
    }
    if (s.mode === 'pan') H.setZoom(clampPan({ ...s.z0, x: s.z0.x + dx, y: s.z0.y + dy, smooth: false }, H.bounds));
    else if (s.mode === 'swipe') setLayer(`translate3d(${swipeOffset(dx, H)}px, 0, 0)`);
    else if (s.mode === 'dismiss') {
      const v = dismissVisual(dy, H.bounds.stageH);
      setLayer(`translate3d(${dx * 0.5}px, ${Math.max(0, dy)}px, 0) scale(${v.scale})`);
      H.onDismissDrag(v.progress);
    }
    return true;
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (e.pointerType !== 'touch') return false;
    touchedAt.current = performance.now();
    if (!pointers.current.delete(e.pointerId)) return true;
    const s = g.current;
    const H = handlers.current;
    if (s.mode === 'pinch') {
      // 捏合松开一指：剩下那指接着平移；都松开了、缩回 1 倍附近就还原
      const rest = [...pointers.current.values()][0];
      const z = H.zoom;
      if (z.scale <= 1.02) H.setZoom(IDENTITY);
      if (rest) beginSingle(rest, e.timeStamp, z.scale > 1.02 ? 'pan' : 'none');
      else s.mode = 'idle';
      return true;
    }
    if (pointers.current.size > 0) return true;
    const mode = s.mode;
    s.mode = 'idle';
    if (cancelled) {
      resetLayer();
      H.onDismissDrag(null);
      return true;
    }
    const { vx, vy } = velocityOf(s.samples);
    if (mode === 'pending' && isTap(e.timeStamp - s.start.t, Math.hypot(s.dx, s.dy))) {
      const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (isDoubleTap(lastTap.current, tap)) {
        window.clearTimeout(tapTimer.current);
        lastTap.current = null;
        const p = toStage(tap);
        H.onDoubleTap(p.x, p.y);
      } else {
        lastTap.current = tap;
        // 等一下看是不是双击的第一下
        window.clearTimeout(tapTimer.current);
        tapTimer.current = window.setTimeout(() => handlers.current.onTap(), GESTURE.doubleTapMs);
      }
    } else if (mode === 'swipe') {
      const width = H.bounds.stageW;
      const go = swipeDecision({ dx: s.dx, vx, width, hasPrev: H.hasPrev, hasNext: H.hasNext });
      if (go === 0) return void resetLayer();
      // 跟手滑出去，再换下一张（新图从同一侧滑进来）
      setLayer(`translate3d(${-go * width}px, 0, 0)`, 180);
      window.setTimeout(() => {
        resetLayer(0);
        if (go > 0) handlers.current.onNext();
        else handlers.current.onPrev();
      }, 170);
    } else if (mode === 'dismiss') {
      if (dragDecision(s.dy, vy, H.bounds.stageH)) {
        // 跟手层缩回原位的同时，图片飞回网格（putBack）；背景保持淡着，交给关闭时的淡出
        resetLayer(300);
        H.onDismiss();
      } else {
        resetLayer();
        H.onDismissDrag(null);
      }
    } else if (mode === 'none' && s.dy < -GESTURE.dismissMax / 2) {
      H.onSwipeUp?.();
    }
    return true;
  };

  return {
    /** 都返回 true = 这是触摸，Stage 不用再按鼠标处理 */
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => finish(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => finish(e, true),
    /** 刚触摸过：浏览器随后补发的 click / dblclick 不按鼠标处理（点背景不关闭、双击不重复） */
    fromTouch: () => performance.now() - touchedAt.current < 700,
  };
}
