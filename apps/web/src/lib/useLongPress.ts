/**
 * 长按（A1）：触屏上按住不动 GESTURE.longPressMs 触发（网格里长按一张进入多选并选中它）。
 * 手指动了（超过 slop，多半是在滚动）、抬起、被浏览器拿去滚动（pointercancel）都作废；
 * 触发后吃掉随后的那一下 click 和系统的长按菜单（存图、新标签打开）。只认 pointerType === 'touch'，鼠标右键菜单照旧。
 */
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { GESTURE, lockAxis } from './gestures';

export interface LongPressHandlers {
  onPointerDown?: (e: PointerEvent) => void;
  onPointerMove?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerCancel?: (e: PointerEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  onClickCapture?: (e: MouseEvent) => void;
}

export function useLongPress(onLongPress: (() => void) | undefined): LongPressHandlers {
  const timer = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const firedAt = useRef(0);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!onLongPress) return {};
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  const fire = () => {
    cancel();
    firedAt.current = Date.now();
    navigator.vibrate?.(8);
    cb.current?.();
  };
  return {
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      start.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(fire, GESTURE.longPressMs);
    },
    onPointerMove: (e) => {
      const s = start.current;
      if (s && lockAxis(e.clientX - s.x, e.clientY - s.y)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // 系统的长按菜单和我们的计时差不多同时到：按着的时候先拦下，顺手当作长按
    onContextMenu: (e) => {
      if (start.current) {
        e.preventDefault();
        fire();
      } else if (Date.now() - firedAt.current < 1000) e.preventDefault();
    },
    onClickCapture: (e) => {
      if (Date.now() - firedAt.current > 800) return;
      firedAt.current = 0;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
