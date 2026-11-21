/**
 * 触屏的缩放和点按（lib/pager 的底层件）：阅读器、看图器共用这一份。只认 pointerType === 'touch'，鼠标、键盘、滚轮各自处理。
 *
 *   双指捏合缩放，以两指中点为中心；放大后单指拖动是平移；缩回 1 倍附近松手就还原；换一张（zoom 的 resetKey）自动还原。
 *   点按：放大着单击 → onTap，双击 → 还原。1 倍时：给了 onDoubleTap 就等一下看是不是双击（看图器：双击放大），
 *   没给就单击立刻 onTap（阅读器：两侧是翻页热区，双击没有意义）。按钮上的点按归按钮自己。
 *   1 倍时一根手指的滑动不归这里（返回 false），交给 useSwipePager。
 *
 * 坐标约定（zoom.ts）：盒子（适应窗口时的尺寸）以舞台（stageRef）中心为原点，transform = translate(x, y) scale(scale)。
 * handlers 都返回 true = 这一下归缩放管，翻页的滑动不用再处理：`zoom.onPointerDown(e) || pager.onPointerDown(e)`。
 */
import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { GESTURE, distance, isDoubleTap, isTap, midpoint, pinchZoom, type Point, type Sample } from '../gestures';
import { clampPan, IDENTITY, type Zoom, type ZoomApi, type ZoomBounds } from './zoom';

type Mode = 'idle' | 'watch' | 'pinch' | 'pan' | 'none';

export function useTouchZoom(o: {
  zoom: ZoomApi;
  stageRef: RefObject<HTMLElement | null>;
  /** 当前这一张的缩放范围（还没量好时 null：不缩放） */
  bounds: () => ZoomBounds | null;
  /** 单击：切换界面 */
  onTap: () => void;
  /** 1 倍时双击（相对舞台中心的坐标）；不给时 1 倍的单击立刻生效 */
  onDoubleTap?: (p: Point) => void;
  /** 第二根手指按下、开始捏合：一根手指的翻页滑动、下滑关闭要弹回 */
  onPinchStart?: () => void;
}) {
  const latest = useRef(o);
  latest.current = o;
  const pointers = useRef(new Map<number, Point>());
  const g = useRef<{ mode: Mode; z0: Zoom; mid0: Point; d0: number; start: Sample; moved: number; onButton: boolean }>({
    mode: 'idle',
    z0: IDENTITY,
    mid0: { x: 0, y: 0 },
    d0: 1,
    start: { x: 0, y: 0, t: 0 },
    moved: 0,
    onButton: false,
  });
  const lastTap = useRef<Sample | null>(null);
  const tapTimer = useRef(0);

  const toStage = (p: Point): Point => {
    const r = latest.current.stageRef.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 } : p;
  };
  const capture = (el: HTMLElement, id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* 指针已经抬起 */
    }
  };
  const begin = (mode: Mode, p: Point, t: number, onButton = false) => {
    g.current = { ...g.current, mode, z0: latest.current.zoom.zoom, start: { ...p, t }, moved: 0, onButton };
  };

  /** 点按：双击（放大着就还原，1 倍时 onDoubleTap），单击等一下看是不是双击的第一下 */
  const tap = (t: Sample, zoomed: boolean) => {
    const O = latest.current;
    window.clearTimeout(tapTimer.current);
    if (!zoomed && !O.onDoubleTap) return O.onTap();
    if (isDoubleTap(lastTap.current, t)) {
      lastTap.current = null;
      if (zoomed) O.zoom.reset();
      else O.onDoubleTap?.(toStage(t));
      return;
    }
    lastTap.current = t;
    tapTimer.current = window.setTimeout(() => latest.current.onTap(), GESTURE.doubleTapMs);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (e.pointerType !== 'touch') return false;
    const O = latest.current;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const b = O.bounds();
      if (!b) return false;
      const [a, c] = [...pointers.current.values()] as [Point, Point];
      // 两根手指都抓住：松手时谁也不会变成按钮上的点按
      for (const id of pointers.current.keys()) capture(e.currentTarget, id);
      g.current = { ...g.current, mode: 'pinch', z0: O.zoom.zoom, mid0: toStage(midpoint(a, c)), d0: distance(a, c) };
      window.clearTimeout(tapTimer.current);
      O.onPinchStart?.();
      return true;
    }
    if (pointers.current.size !== 1) return g.current.mode !== 'idle' && g.current.mode !== 'watch';
    const p = { x: e.clientX, y: e.clientY };
    if (O.zoom.zoomed) {
      if ((e.target as Element).closest('button')) return true;
      capture(e.currentTarget, e.pointerId);
      begin('pan', p, e.timeStamp);
      return true;
    }
    // 1 倍：只看看是不是点按，滑动交给翻页
    begin('watch', p, e.timeStamp, !!(e.target as Element).closest('button'));
    return false;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (e.pointerType !== 'touch' || !pointers.current.has(e.pointerId)) return false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    const O = latest.current;
    if (s.mode === 'pinch') {
      const b = O.bounds();
      const [a, c] = [...pointers.current.values()];
      if (!b || !a || !c) return true;
      const z = pinchZoom(s.z0, s.mid0, s.d0, toStage(midpoint(a, c)), distance(a, c), 1, b.maxScale);
      O.zoom.setZoom(clampPan({ ...z, smooth: false }, b));
      return true;
    }
    const dx = e.clientX - s.start.x;
    const dy = e.clientY - s.start.y;
    s.moved = Math.max(s.moved, Math.hypot(dx, dy));
    if (s.mode === 'pan') {
      const b = O.bounds();
      if (b) O.zoom.setZoom(clampPan({ ...s.z0, x: s.z0.x + dx, y: s.z0.y + dy, smooth: false }, b));
      return true;
    }
    return s.mode === 'none';
  };

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): boolean => {
    if (e.pointerType !== 'touch' || !pointers.current.delete(e.pointerId)) return false;
    const s = g.current;
    const O = latest.current;
    if (s.mode === 'idle') return false;
    const rest = [...pointers.current.values()][0];
    if (s.mode === 'pinch') {
      // 松开一指：放大着就用剩下那指接着平移；缩回 1 倍附近就还原，剩下那指什么也不做
      const big = O.zoom.zoom.scale > 1.02;
      if (!big) O.zoom.setZoom(IDENTITY);
      if (rest) {
        if (big) begin('pan', rest, e.timeStamp);
        else s.mode = 'none';
      } else s.mode = 'idle';
      return true;
    }
    if (rest) return s.mode !== 'watch';
    const mode = s.mode;
    s.mode = 'idle';
    const t = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    const isATap = !cancelled && !s.onButton && isTap(e.timeStamp - s.start.t, s.moved);
    if (mode === 'pan') {
      if (isATap) tap(t, true);
      return true;
    }
    // 1 倍的点按：认完以后照样交给翻页收尾（它那边没动过，什么也不做）
    if (mode === 'watch' && isATap) tap(t, false);
    return mode === 'none';
  };

  const { zoom, zoomed } = o.zoom;
  return {
    /** 盒子上的 transform：离散操作（还原、双击）带过渡，捏合、拖动跟手 */
    style: {
      transform: zoomed ? `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` : undefined,
      transition: zoom.smooth ? 'transform 280ms var(--ease-out-soft)' : 'none',
    } as React.CSSProperties,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    },
  };
}
