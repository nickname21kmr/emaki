import { useRef, useState, type RefObject, type PointerEvent, type KeyboardEvent } from 'react';
import type { Position } from './presentation';

type Edge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
interface Size { width: number; height: number }
interface Rect extends Size, Position {}
const KEY = 'emaki.assistant.panel-size';
/** 浮页最小 320 × 400（§3.1） */
const MIN: Size = { width: 320, height: 400 };
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/** Keep the opposite edge anchored and all handles inside the viewport. */
export function resizeRect(r: Rect, edge: Edge, dx: number, dy: number, vw: number, vh: number, min: Size = { width: 320, height: 360 }): Rect {
  let left = r.x, top = r.y, right = r.x + r.width, bottom = r.y + r.height;
  const minW = Math.min(min.width, vw - 16), minH = Math.min(min.height, vh - 16);
  if (edge.includes('w')) left = clamp(left + dx, 8, right - minW);
  if (edge.includes('e')) right = clamp(right + dx, left + minW, vw - 8);
  if (edge.includes('n')) top = clamp(top + dy, 8, bottom - minH);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH, vh - 8);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// 只给指针用的热区（不进 Tab 顺序）：边 6px、角 14px，触屏加宽到 12 / 24
const EDGES: { edge: Exclude<Edge, 'se'>; classes: string }[] = [
  { edge: 'n', classes: 'top-0 inset-x-3.5 h-1.5 cursor-ns-resize pointer-coarse:inset-x-6 pointer-coarse:h-3' },
  { edge: 's', classes: 'bottom-0 inset-x-3.5 h-1.5 cursor-ns-resize pointer-coarse:inset-x-6 pointer-coarse:h-3' },
  { edge: 'w', classes: 'left-0 inset-y-3.5 w-1.5 cursor-ew-resize pointer-coarse:inset-y-6 pointer-coarse:w-3' },
  { edge: 'e', classes: 'right-0 inset-y-3.5 w-1.5 cursor-ew-resize pointer-coarse:inset-y-6 pointer-coarse:w-3' },
  { edge: 'nw', classes: 'left-0 top-0 size-3.5 cursor-nwse-resize pointer-coarse:size-6' },
  { edge: 'ne', classes: 'right-0 top-0 size-3.5 cursor-nesw-resize pointer-coarse:size-6' },
  { edge: 'sw', classes: 'left-0 bottom-0 size-3.5 cursor-nesw-resize pointer-coarse:size-6' },
];

function readSize(): Size | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')?.normal;
    return Number.isFinite(saved?.width) && saved.width > 0 && Number.isFinite(saved?.height) && saved.height > 0 ? { width: saved.width, height: saved.height } : undefined;
  } catch { return undefined; }
}

/**
 * 浮页的缩放（§3.5）：七个只给指针的热区，加一个能聚焦的右下角手柄（方向键 10px，Shift 40px）。
 * 手柄都放在外壳 DOM 的最后；外壳要带 group/sheet，悬停时右下角露出两道斜线。
 * reserve：没存过位置时底边离视口底的距离加 24px 上边距（让位多选栏时更大），高度不超过 vh − reserve。
 */
export function useFloatingResize(ref: RefObject<HTMLElement | null>, place: (p: Position) => void, reserve = 16) {
  const [size, setSize] = useState<Size | undefined>(readSize);
  const gesture = useRef<{ id: number; edge: Edge; x: number; y: number; rect: Rect } | null>(null);
  const rect = (): Rect | null => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  };
  const apply = (r: Rect, edge: Edge, dx: number, dy: number) => {
    const next = resizeRect(r, edge, dx, dy, window.innerWidth, window.innerHeight, MIN);
    place({ x: next.x, y: next.y });
    const value = { width: next.width, height: next.height };
    setSize(value);
    // 旧的「展开」档不再读写
    try { localStorage.setItem(KEY, JSON.stringify({ normal: value })); } catch { /* storage may be disabled */ }
  };
  const pointer = (edge: Edge) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!e.isPrimary || e.button !== 0) return;
      const r = rect(); if (!r) return;
      e.preventDefault(); e.stopPropagation();
      gesture.current = { id: e.pointerId, edge, x: e.clientX, y: e.clientY, rect: r };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const g = gesture.current; if (!g || g.id !== e.pointerId) return;
      e.preventDefault(); apply(g.rect, g.edge, e.clientX - g.x, e.clientY - g.y);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  });
  function finish(e: PointerEvent<HTMLElement>) {
    if (gesture.current?.id !== e.pointerId) return;
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const r = rect(); if (!r) return;
    e.preventDefault(); e.stopPropagation();
    const step = e.shiftKey ? 40 : 10;
    apply(r, 'se', e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
  };
  return {
    size,
    style: size ? { width: `min(${size.width}px, calc(100vw - 16px))`, height: `min(${size.height}px, calc(100vh - ${reserve}px))` } : undefined,
    handles: (
      <>
        {EDGES.map(({ edge, classes }) => (
          <div key={edge} aria-hidden className={`absolute z-10 touch-none select-none ${classes}`} {...pointer(edge)} />
        ))}
        <button
          type="button"
          aria-label="调整助手大小"
          className="group/grip absolute right-0 bottom-0 z-10 size-5 cursor-nwse-resize touch-none select-none pointer-coarse:size-6"
          {...pointer('se')}
          onKeyDown={onKeyDown}
        >
          <svg aria-hidden viewBox="0 0 10 10" className="absolute right-[5px] bottom-[5px] size-2.5 text-fg-subtle/60 opacity-0 transition-opacity duration-150 group-hover/sheet:opacity-100 group-focus-visible/grip:opacity-100">
            <path d="M9 3 3 9M9 6.5 6.5 9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </>
    ),
  };
}
