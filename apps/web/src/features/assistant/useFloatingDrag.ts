import { useLayoutEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react';
import { clampPosition, type Position } from './presentation';
import { dragMotion } from './dragMotion';

function readPosition(key: string): Position | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? value : null;
  } catch { return null; }
}

/** A handle moves its whole floating surface. Each storage key has its own position. */
export function useFloatingDrag(key: string) {
  const ref = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<Position | null>(() => readPosition(key));
  const current = useRef(position), suppressClick = useRef(false);
  const gesture = useRef<{ id: number; x: number; y: number; origin: Position; moved: boolean; motion: ReturnType<typeof dragMotion> } | null>(null);
  const place = (next: Position) => {
    if (current.current?.x === next.x && current.current?.y === next.y) return;
    current.current = next; setPosition(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage may be disabled */ }
  };
  const move = (point: Position) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = clampPosition(point, rect.width, rect.height, window.innerWidth, window.innerHeight);
    place(next);
  };
  useLayoutEffect(() => {
    // 换了 key 就在绘制前读回那个 key 的位置，再按当前视口夹一次
    const restored = readPosition(key);
    current.current = restored;
    setPosition(restored);
    const fit = () => { if (!gesture.current && current.current) move(current.current); };
    const observer = new ResizeObserver(fit);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', fit); fit();
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); gesture.current?.motion.cancel(); gesture.current = null; };
  }, [key]);
  const finish = (e: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== e.pointerId) return;
    const g = gesture.current;
    suppressClick.current = g.moved;
    if (g.moved) place(g.motion.finish());
    else g.motion.cancel();
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return {
    ref,
    place,
    style: position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined,
    handle: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (!e.isPrimary || e.button !== 0) return;
        const control = (e.target as Element).closest('button,a,input,select,textarea');
        if (control && control !== e.currentTarget) return;
        const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
        suppressClick.current = false;
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: { x: rect.left, y: rect.top }, moved: false,
          motion: dragMotion(ref.current!, rect, { x: window.innerWidth, y: window.innerHeight }) };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const g = gesture.current; if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 5) return;
        g.moved = true; e.preventDefault(); g.motion.move({ x: g.origin.x + dx, y: g.origin.y + dy });
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (suppressClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; }
      },
    },
  };
}
