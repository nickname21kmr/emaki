import { useRef, useState, type RefObject, type PointerEvent } from 'react';
import type { Position } from './presentation';

type Edge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
interface Size { width: number; height: number }
interface Rect extends Size, Position {}
const KEY = 'emaki.assistant.panel-size';
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/** Keep the opposite edge anchored and all handles inside the viewport. */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number, vw: number, vh: number): Rect {
  let left = r.x, top = r.y, right = r.x + r.width, bottom = r.y + r.height;
  const minW = Math.min(320, vw - 16), minH = Math.min(360, vh - 16);
  if (edge.includes('w')) left = clamp(left + dx, 8, right - minW);
  if (edge.includes('e')) right = clamp(right + dx, left + minW, vw - 8);
  if (edge.includes('n')) top = clamp(top + dy, 8, bottom - minH);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH, vh - 8);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const edges: { edge: Edge; label: string; classes: string }[] = [
  { edge: 'n', label: '上边缘', classes: 'top-0 inset-x-3 h-2 cursor-ns-resize' },
  { edge: 's', label: '下边缘', classes: 'bottom-0 inset-x-3 h-2 cursor-ns-resize' },
  { edge: 'w', label: '左边缘', classes: 'left-0 inset-y-3 w-2 cursor-ew-resize' },
  { edge: 'e', label: '右边缘', classes: 'right-0 inset-y-3 w-2 cursor-ew-resize' },
  { edge: 'nw', label: '左上角', classes: 'left-0 top-0 size-3 cursor-nwse-resize' },
  { edge: 'ne', label: '右上角', classes: 'right-0 top-0 size-3 cursor-nesw-resize' },
  { edge: 'sw', label: '左下角', classes: 'left-0 bottom-0 size-3 cursor-nesw-resize' },
  { edge: 'se', label: '右下角', classes: 'right-0 bottom-0 size-3 cursor-nwse-resize' },
];

export function useFloatingResize(ref: RefObject<HTMLElement | null>, place: (p: Position) => void, expanded: boolean) {
  const [sizes, setSizes] = useState<Partial<Record<'normal' | 'expanded', Size>>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      return Object.fromEntries(['normal', 'expanded'].filter(k => Number.isFinite(saved?.[k]?.width) && saved[k].width > 0 && Number.isFinite(saved[k].height) && saved[k].height > 0).map(k => [k, saved[k]]));
    } catch { return {}; }
  });
  const gesture = useRef<{ id: number; edge: Edge; x: number; y: number; rect: Rect } | null>(null);
  const mode = expanded ? 'expanded' : 'normal';
  const rect = (): Rect | null => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  };
  const apply = (r: Rect, edge: Edge, dx: number, dy: number) => {
    const next = resizeRect(r, edge, dx, dy, window.innerWidth, window.innerHeight);
    place({ x: next.x, y: next.y });
    setSizes(previous => {
      const value = { ...previous, [mode]: { width: next.width, height: next.height } };
      try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* storage may be disabled */ }
      return value;
    });
  };
  const finish = (e: PointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.id !== e.pointerId) return;
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const size = sizes[mode];
  return {
    style: size ? { width: `min(${size.width}px, calc(100vw - 16px))`, height: `min(${size.height}px, calc(100vh - 16px))` } : undefined,
    handles: edges.map(({ edge, label, classes }) => <button key={edge} type="button" aria-label={`调整助手大小：${label}`} title="拖动调整大小，或用方向键微调" className={`absolute z-50 touch-none select-none border-0 bg-transparent p-0 focus-visible:bg-shu/20 ${classes}`}
      onPointerDown={e => {
        if (!e.isPrimary || e.button !== 0) return;
        const r = rect(); if (!r) return;
        e.preventDefault(); e.stopPropagation();
        gesture.current = { id: e.pointerId, edge, x: e.clientX, y: e.clientY, rect: r };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const g = gesture.current; if (!g || g.id !== e.pointerId) return;
        e.preventDefault(); apply(g.rect, g.edge, e.clientX - g.x, e.clientY - g.y);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const r = rect(); if (!r) return;
        e.preventDefault(); e.stopPropagation(); const step = e.shiftKey ? 40 : 10;
        apply(r, edge, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      }} />),
  };
}
