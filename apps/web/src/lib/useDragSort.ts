/**
 * 拖动排序，只有这一份（docs/FRONTEND.md「交互只有一个实现」）：插件页的「页面顺序」用它，以后别的列表要拖着排也用它。
 * 鼠标和触屏都行：按住每一行的把手拖，过了 GESTURE.slop 才算拖（点一下把手什么都不做）；几个列表算一组，能拖到别的列表里。
 *
 *   const sort = useDragSort({ container: ref, lists, onDrop: (next) => 保存 });
 *   <div ref={ref} className="relative">            ← 要 relative：位置按它算
 *     {keys.map((k) => <ul data-sort-group={k}>{sort.order[k].map((id) =>
 *       <li data-sort-item={id} data-dragging={sort.dragging === id || undefined}><span {...sort.handle(id)} />…</li>)}</ul>)}
 *   </div>
 *
 * 拖着的那一行跟手（直接写 style，不走 React 状态），别的行实时让出位置（sort.order 是拖着时的顺序，挪动的行滑过去）；
 * 拖着的那一行的上边越过上面一行的中线、下边越过下面一行的中线就换位置，拖到两段之间算离得近的那段。
 * 靠近滚动区的上下边自动滚。松手时顺序和原来不一样才 onDrop；Esc、指针被打断就放回去。
 * 键盘和读屏用每一行自己的「上移 / 下移」，把手不进 Tab 顺序。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { GESTURE } from './gestures';

export type SortLists<K extends string> = Record<K, string[]>;

export interface SortTarget<K extends string = string> {
  group: K;
  /** 在这一组里（不算拖着的那一行）排第几 */
  index: number;
}

/** 一组的位置（data-sort-group）：上下边和每一行，都按布局（不算动画），拖着的那一行在它现在的空位上 */
export interface SortGroupBox<K extends string = string> {
  key: K;
  top: number;
  bottom: number;
  items: { id: string; top: number; bottom: number }[];
}

const mid = (i: { top: number; bottom: number }) => (i.top + i.bottom) / 2;

/**
 * 拖着的那一行（跟手的上下边）该在哪：中心在哪一组里就是哪一组（在两组之间算离得近的）。
 * 同一组里：原来在它上面的行，它的上边越过了那一行的中线就换到它下面；原来在下面的，下边越过了中线就换到上面。
 * 别的组里：按中心排。
 */
export function sortTarget<K extends string>(
  groups: readonly SortGroupBox<K>[],
  drag: { id: string; top: number; bottom: number },
): SortTarget<K> | null {
  if (!groups.length) return null;
  const c = mid(drag);
  const dist = (g: SortGroupBox<K>) => (c < g.top ? g.top - c : c > g.bottom ? c - g.bottom : 0);
  const g = groups.reduce((best, x) => (dist(x) < dist(best) ? x : best));
  const slot = g.items.findIndex((i) => i.id === drag.id);
  if (slot < 0) return { group: g.key, index: g.items.filter((i) => mid(i) < c).length };
  const index = g.items.reduce((n, it, j) => (j === slot ? n : n + ((j < slot ? mid(it) <= drag.top : mid(it) < drag.bottom) ? 1 : 0)), 0);
  return { group: g.key, index };
}

/** 把 id 挪到 to；位置没变返回 null */
export function moveTo<K extends string>(
  lists: Readonly<Record<K, readonly string[]>>,
  id: string,
  to: SortTarget<K>,
): SortLists<K> | null {
  const next = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...(v as string[])]])) as SortLists<K>;
  const from = (Object.keys(next) as K[]).find((k) => next[k].includes(id));
  if (from === undefined || !next[to.group]) return null;
  const at = next[from].indexOf(id);
  if (from === to.group && at === to.index) return null;
  next[from].splice(at, 1);
  next[to.group].splice(Math.min(to.index, next[to.group].length), 0, id);
  return next;
}

export const sameLists = <K extends string>(a: Readonly<Record<K, readonly string[]>>, b: Readonly<Record<K, readonly string[]>>) =>
  (Object.keys(a) as K[]).every((k) => a[k].length === b[k]?.length && a[k].every((x, i) => x === b[k][i]));

/** 离滚动区的上下边多近开始自动滚（px），最快每帧滚多少 */
const EDGE = 56;
const MAX_SPEED = 14;
/** 让位、放下的滑动 */
const SLIDE = { duration: 160, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

/** 指针在 y 时每帧滚多少：靠上边是负的，越近越快；不在边上是 0 */
export function edgeScroll(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -Math.ceil(MAX_SPEED * Math.min(1, (top + EDGE - y) / EDGE));
  if (y > bottom - EDGE) return Math.ceil(MAX_SPEED * Math.min(1, (y - (bottom - EDGE)) / EDGE));
  return 0;
}

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement as HTMLElement;
}

/** 元素在 root 里的布局位置（offsetTop 一路加上去，不算 transform、动画） */
function topIn(el: HTMLElement, root: HTMLElement): number {
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}

interface Drag {
  id: string;
  pointer: number;
  startY: number;
  y: number;
  active: boolean;
  /** 指针在那一行里的位置、那一行的高 */
  grab: number;
  height: number;
  scroller: HTMLElement | null;
  frame: number;
}

interface Options<K extends string> {
  /** 几个列表外面的那个元素（要 relative） */
  container: RefObject<HTMLElement | null>;
  /** 现在的顺序 */
  lists: Readonly<Record<K, readonly string[]>>;
  /** 松手了，顺序变了 */
  onDrop: (next: SortLists<K>, id: string) => void;
  /** 现在能不能拖（没有权限、正在保存） */
  disabled?: boolean;
}

type Preview<K extends string> = { id: string; order: SortLists<K> } | null;

/** 拖动的过程：只读 ref，建一次，挂在 window 上的监听每次都是同一个函数 */
function engine<K extends string>(latest: { current: Options<K> }, setPreviewState: (p: Preview<K>) => void) {
  let drag: Drag | null = null;
  let preview: Preview<K> = null;
  /** 换位置前各行在屏幕上的位置：画完以后从那里滑到新位置（FLIP） */
  let flip: Map<string, number> | null = null;

  const setPreview = (p: Preview<K>) => {
    preview = p;
    setPreviewState(p);
  };
  const root = () => latest.current.container.current;
  const rows = () => [...(root()?.querySelectorAll<HTMLElement>('[data-sort-item]') ?? [])];
  const rowOf = (id: string) => rows().find((r) => r.dataset.sortItem === id) ?? null;
  const snapshot = () => new Map(rows().map((r) => [r.dataset.sortItem!, r.getBoundingClientRect().top]));

  const layout = (r: HTMLElement): SortGroupBox<K>[] =>
    [...r.querySelectorAll<HTMLElement>('[data-sort-group]')].map((g) => {
      const top = topIn(g, r);
      return {
        key: g.dataset.sortGroup as K,
        top,
        bottom: top + g.offsetHeight,
        items: [...g.querySelectorAll<HTMLElement>('[data-sort-item]')].map((i) => {
          const t = topIn(i, r);
          return { id: i.dataset.sortItem!, top: t, bottom: t + i.offsetHeight };
        }),
      };
    });

  /** 拖着的那一行的上边（root 里的布局坐标） */
  const dragTop = (d: Drag, r: HTMLElement) => d.y - r.getBoundingClientRect().top - d.grab;

  /** 拖着的那一行贴到指针上 */
  const follow = () => {
    const r = root();
    const row = drag && rowOf(drag.id);
    if (!drag?.active || !r || !row) return;
    row.style.transform = `translateY(${dragTop(drag, r) - topIn(row, r)}px)`;
  };

  /** 跟手，过了别的行的中线就换位置 */
  const update = () => {
    const r = root();
    if (!drag?.active || !r) return;
    follow();
    const top = dragTop(drag, r);
    const t = sortTarget(layout(r), { id: drag.id, top, bottom: top + drag.height });
    const next = t && moveTo(preview?.order ?? latest.current.lists, drag.id, t);
    if (!next) return;
    flip = snapshot();
    setPreview({ id: drag.id, order: next });
  };

  /** 画完以后：换了位置（或者放下了）的行从原来的地方滑过去；拖着的那一行重新贴到指针上 */
  const afterRender = () => {
    const first = flip;
    flip = null;
    if (first) {
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      for (const row of rows()) {
        const id = row.dataset.sortItem!;
        if (drag?.active && id === drag.id) continue;
        const from = first.get(id);
        row.getAnimations?.().forEach((a) => a.cancel());
        if (from === undefined || still) continue;
        const delta = from - row.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) row.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], SLIDE);
      }
    }
    follow();
  };

  const tick = () => {
    if (!drag?.active) return;
    const s = drag.scroller;
    if (s) {
      const box = s === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : s.getBoundingClientRect();
      const v = edgeScroll(drag.y, box.top, box.bottom);
      if (v) {
        s.scrollTop += v;
        update();
      }
    }
    drag.frame = requestAnimationFrame(tick);
  };

  const onMove = (e: PointerEvent) => {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    d.y = e.clientY;
    if (!d.active) {
      if (Math.abs(d.y - d.startY) < GESTURE.slop) return;
      const r = root();
      const row = rowOf(d.id);
      if (!r || !row) return end(false);
      d.active = true;
      d.grab = d.startY - r.getBoundingClientRect().top - topIn(row, r);
      d.height = row.offsetHeight;
      d.scroller = scrollParent(r);
      d.frame = requestAnimationFrame(tick);
      document.documentElement.style.userSelect = 'none';
      document.documentElement.style.cursor = 'grabbing';
      setPreview({ id: d.id, order: latest.current.lists as SortLists<K> });
    }
    update();
  };
  const onUp = (e: PointerEvent) => {
    if (drag?.pointer === e.pointerId) end(true);
  };
  const onCancel = () => end(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag?.active) return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };

  function end(drop: boolean) {
    const d = drag;
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (!d?.active) return;
    cancelAnimationFrame(d.frame);
    document.documentElement.style.userSelect = '';
    document.documentElement.style.cursor = '';
    // 从现在的样子（拖着的那一行在指针下）滑到放下以后的位置
    flip = snapshot();
    const row = rowOf(d.id);
    if (row) row.style.transform = '';
    const order = preview?.order;
    setPreview(null);
    if (drop && order && !sameLists(order, latest.current.lists)) latest.current.onDrop(order, d.id);
  }

  const start = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || latest.current.disabled || drag) return;
    e.preventDefault(); // 不选中文字
    drag = { id, pointer: e.pointerId, startY: e.clientY, y: e.clientY, active: false, grab: 0, height: 0, scroller: null, frame: 0 };
    // 挂在 window 上：拖到别的列表时这一行会重新画（换了元素），指针事件照样收得到
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  return { start, end, afterRender };
}

export function useDragSort<K extends string>(o: Options<K>) {
  const latest = useRef(o);
  latest.current = o;
  // 拖着时的顺序（让位用）
  const [preview, setPreview] = useState<Preview<K>>(null);
  const [e] = useState(() => engine(latest, setPreview));

  useLayoutEffect(() => e.afterRender());
  // 拖到一半页面没了：收拾干净
  useEffect(() => () => e.end(false), [e]);

  return {
    /** 现在该画的顺序（拖着时是让过位的） */
    order: (preview?.order ?? o.lists) as Readonly<Record<K, readonly string[]>>,
    /** 正在拖的那一行 */
    dragging: preview?.id ?? null,
    /** 把手上的：只有按住把手才拖，行里的按钮、开关照常用 */
    handle: (id: string) => ({
      'aria-hidden': true as const,
      style: { touchAction: 'none' as const, cursor: o.disabled ? undefined : 'grab' },
      onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => e.start(id, ev),
      // 触屏上按住把手不弹系统菜单
      onContextMenu: (ev: ReactMouseEvent<HTMLElement>) => ev.preventDefault(),
    }),
  };
}
