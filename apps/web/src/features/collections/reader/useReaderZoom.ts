/**
 * 阅读器的双指缩放（A1 真机走查：平板竖屏单页看漫画，字太小）。只认 pointerType === 'touch'，鼠标、键盘、滚轮照旧。
 *
 *   双指捏合缩放，以两指中点为中心（和看图器同一套数学：lib/gestures.ts 的 pinchZoom、useZoomPan 的 clampPan）；
 *   放大后单指拖动是平移，不翻页；双击还原；单击切换顶栏和胶片条；缩回 1 倍附近松手就还原；换一开自动还原。
 *   1 倍时一根手指的滑动、点按不归这里管（返回 false），交给 useSwipePager 和两侧的翻页热区。
 *
 * 坐标约定同看图器：页面盒子（boxRef，适应窗口时的尺寸）以舞台（stageRef）中心为原点，
 * transform = translate(x, y) scale(scale)，transform-origin 在盒子中心。
 */
import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { clampPan, IDENTITY, useZoomPan, type Zoom, type ZoomBounds } from '@/components/media/lightbox/useZoomPan';
import { GESTURE, distance, isDoubleTap, isTap, midpoint, pinchZoom, type Point, type Sample } from '@/lib/gestures';

/** 最多放大到适应窗口的几倍（漫画页的原图一般是屏幕的一两倍，4 倍够看清网点） */
export const READER_MAX_SCALE = 4;

type Mode = 'idle' | 'pinch' | 'pan' | 'none';

export function useReaderZoom(
  resetKey: string,
  stageRef: RefObject<HTMLElement | null>,
  boxRef: RefObject<HTMLElement | null>,
  o: {
    /** 放大时的单击：切换顶栏和胶片条 */
    onTap: () => void;
    /** 第二根手指按下、开始捏合：一根手指的翻页滑动要弹回 */
    onPinchStart: () => void;
  },
) {
  const { zoom, setZoom, reset, zoomed } = useZoomPan(resetKey);
  const latest = useRef({ zoom, o });
  latest.current = { zoom, o };
  const pointers = useRef(new Map<number, Point>());
  const g = useRef<{ mode: Mode; z0: Zoom; mid0: Point; d0: number; start: Sample; moved: number }>({
    mode: 'idle',
    z0: IDENTITY,
    mid0: { x: 0, y: 0 },
    d0: 1,
    start: { x: 0, y: 0, t: 0 },
    moved: 0,
  });
  const lastTap = useRef<Sample | null>(null);
  const tapTimer = useRef(0);

  const bounds = (): ZoomBounds | null => {
    const stage = stageRef.current;
    const box = boxRef.current;
    if (!stage || !box || !box.offsetWidth) return null;
    return {
      boxW: box.offsetWidth,
      boxH: box.offsetHeight,
      stageW: stage.clientWidth,
      stageH: stage.clientHeight,
      maxScale: READER_MAX_SCALE,
    };
  };
  /** 相对舞台中心的坐标 */
  const toStage = (p: Point): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 } : p;
  };
  const capture = (el: HTMLElement, id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* 指针已经抬起 */
    }
  };
  const beginPan = (p: Point, t: number) => {
    g.current = { ...g.current, mode: 'pan', z0: latest.current.zoom, start: { ...p, t }, moved: 0 };
  };

  /** 都返回 true = 这一下归缩放管，翻页的滑动不用再处理 */
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (e.pointerType !== 'touch') return false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const b = bounds();
      if (!b) return false;
      const [a, c] = [...pointers.current.values()] as [Point, Point];
      // 两根手指都抓住：松手时谁也不会变成按钮上的点按
      for (const id of pointers.current.keys()) capture(e.currentTarget, id);
      g.current = { ...g.current, mode: 'pinch', z0: latest.current.zoom, mid0: toStage(midpoint(a, c)), d0: distance(a, c) };
      window.clearTimeout(tapTimer.current);
      latest.current.o.onPinchStart();
      return true;
    }
    if (pointers.current.size === 1 && latest.current.zoom.scale > 1.001) {
      capture(e.currentTarget, e.pointerId);
      beginPan({ x: e.clientX, y: e.clientY }, e.timeStamp);
      return true;
    }
    return g.current.mode !== 'idle';
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (e.pointerType !== 'touch' || !pointers.current.has(e.pointerId)) return false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    if (s.mode === 'pinch') {
      const b = bounds();
      const [a, c] = [...pointers.current.values()];
      if (!b || !a || !c) return true;
      const z = pinchZoom(s.z0, s.mid0, s.d0, toStage(midpoint(a, c)), distance(a, c), 1, b.maxScale);
      setZoom(clampPan({ ...z, smooth: false }, b));
      return true;
    }
    if (s.mode === 'pan') {
      const b = bounds();
      const dx = e.clientX - s.start.x;
      const dy = e.clientY - s.start.y;
      s.moved = Math.max(s.moved, Math.hypot(dx, dy));
      if (b) setZoom(clampPan({ ...s.z0, x: s.z0.x + dx, y: s.z0.y + dy, smooth: false }, b));
      return true;
    }
    return s.mode === 'none';
  };

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): boolean => {
    if (e.pointerType !== 'touch' || !pointers.current.delete(e.pointerId)) return false;
    const s = g.current;
    if (s.mode === 'idle') return false;
    const rest = [...pointers.current.values()][0];
    if (s.mode === 'pinch') {
      // 松开一指：放大着就用剩下那指接着平移；缩回 1 倍附近就还原，剩下那指什么也不做
      const big = latest.current.zoom.scale > 1.02;
      if (!big) setZoom(IDENTITY);
      if (rest) {
        if (big) beginPan(rest, e.timeStamp);
        else s.mode = 'none';
      } else s.mode = 'idle';
      return true;
    }
    if (rest) return true;
    const mode = s.mode;
    s.mode = 'idle';
    if (mode !== 'pan' || cancelled || !isTap(e.timeStamp - s.start.t, s.moved)) return true;
    // 放大时的点按：双击还原，单击（等一下看是不是双击的第一下）切换界面
    const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    window.clearTimeout(tapTimer.current);
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      setZoom(IDENTITY);
    } else {
      lastTap.current = tap;
      tapTimer.current = window.setTimeout(() => latest.current.o.onTap(), GESTURE.doubleTapMs);
    }
    return true;
  };

  return {
    zoom,
    zoomed,
    reset,
    /** 页面盒子上的 transform：离散操作（还原）带过渡，捏合、拖动跟手 */
    style: {
      transform: zoomed ? `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` : undefined,
      transition: zoom.smooth ? 'transform 250ms var(--ease-out-soft)' : 'none',
    },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    },
  };
}
