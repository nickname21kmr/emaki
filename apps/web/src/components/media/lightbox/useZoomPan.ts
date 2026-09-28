import { useCallback, useState } from 'react';

/**
 * 看图器的缩放 / 平移状态。
 *
 * 坐标约定：图片盒子（按「适应窗口」算好的尺寸）以舞台中心为原点，
 * transform = translate(x, y) scale(scale)，transform-origin 在盒子中心。
 * scale = 1 就是适应窗口；换图（resetKey 变化）自动回到 1。
 */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
  /** 离散操作（双击 / 按键 / 还原）用过渡动画；滚轮和拖动要跟手，不加过渡 */
  smooth: boolean;
}

export interface ZoomBounds {
  /** 适应窗口时盒子的尺寸 */
  boxW: number;
  boxH: number;
  /** 舞台（可视区域）尺寸 */
  stageW: number;
  stageH: number;
  maxScale: number;
}

export const IDENTITY: Zoom = { scale: 1, x: 0, y: 0, smooth: true };

/** 平移不能把图片拖出可视区域：图片比舞台大时，边缘最多拖到舞台边缘 */
export function clampPan(z: Zoom, b: ZoomBounds): Zoom {
  const maxX = Math.max(0, (b.boxW * z.scale - b.stageW) / 2);
  const maxY = Math.max(0, (b.boxH * z.scale - b.stageH) / 2);
  return { ...z, x: Math.min(maxX, Math.max(-maxX, z.x)), y: Math.min(maxY, Math.max(-maxY, z.y)) };
}

/**
 * 以某点为锚缩放（px, py 是相对舞台中心的坐标），锚点下的像素保持不动。
 * t' = p - (p - t) · s'/s
 */
export function zoomAround(z: Zoom, nextScale: number, px: number, py: number, b: ZoomBounds, smooth: boolean): Zoom {
  const scale = Math.min(b.maxScale, Math.max(1, nextScale));
  if (scale <= 1.001) return { ...IDENTITY, smooth };
  const k = scale / z.scale;
  return clampPan({ scale, x: px - (px - z.x) * k, y: py - (py - z.y) * k, smooth }, b);
}

export function useZoomPan(resetKey: string | undefined) {
  const [state, setState] = useState<{ key: string | undefined; zoom: Zoom }>({ key: resetKey, zoom: IDENTITY });
  // 换图时不用 effect 重置：key 对不上就当作初始状态（避免闪一帧旧的缩放）
  const zoom = state.key === resetKey ? state.zoom : IDENTITY;

  const setZoom = useCallback(
    (next: Zoom | ((prev: Zoom) => Zoom)) =>
      setState((s) => {
        const prev = s.key === resetKey ? s.zoom : IDENTITY;
        return { key: resetKey, zoom: typeof next === 'function' ? next(prev) : next };
      }),
    [resetKey],
  );

  const reset = useCallback(() => setZoom(IDENTITY), [setZoom]);

  return { zoom, setZoom, reset, zoomed: zoom.scale > 1.001 };
}

export type ZoomApi = ReturnType<typeof useZoomPan>;
