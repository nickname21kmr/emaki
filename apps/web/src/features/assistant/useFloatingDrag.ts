import { useEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react';
import { clampPosition, type Position } from './presentation';

/** A handle moves its whole floating surface. Positions are local to this browser. */
export function useFloatingDrag(key: string) {
  const ref = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<Position | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? value : null;
    } catch { return null; }
  });
  const current = useRef(position), suppressClick = useRef(false);
  const gesture = useRef<{ id: number; x: number; y: number; origin: Position; moved: boolean } | null>(null);
  const place = (next: Position) => {
    current.current = next; setPosition(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage may be disabled */ }
  };
  const move = (point: Position) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = clampPosition(point, rect.width, rect.height, window.innerWidth, window.innerHeight);
    place(next);
  };
  useEffect(() => {
    const fit = () => { if (current.current) move(current.current); };
    const observer = new ResizeObserver(fit);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', fit); fit();
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [key]);
  const finish = (e: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== e.pointerId) return;
    suppressClick.current = gesture.current.moved;
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
        gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: { x: rect.left, y: rect.top }, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const g = gesture.current; if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 5) return;
        g.moved = true; move({ x: g.origin.x + dx, y: g.origin.y + dy });
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
