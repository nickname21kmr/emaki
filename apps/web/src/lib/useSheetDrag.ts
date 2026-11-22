/**
 * 底部面板的「往下拖收起」（还有往上拉展开），只有这一份：components/ui/Sheet（手机上的「更多」、筛选、compact 下的弹窗）
 * 和看图器窄屏的信息面板 lightbox/InfoSheet 都用它。
 *
 *   const drag = useSheetDrag({ target: ref, onClose, onExpand?, canStart? });
 *   <div {...drag}>…把手那一块…</div>
 *
 * 按下以后先不算拖，移动过了 GESTURE.slop 才接管（抓住指针、面板跟手），所以拖的那一块里的按钮照常能点。
 * 往下拖跟手，松手时过了阈值（距离或速度，lib/gestures.ts 的 dragDecision）就 onClose，没过弹回；
 * 给了 onExpand 时往上拉带一点阻尼，松手就展开，没给时拉不上去。拖过以后浏览器补发的那个 click 吃掉。
 */
import { useRef, type PointerEvent, type RefObject } from 'react';
import { GESTURE, dragDecision } from './gestures';

/** 往上拉的阻尼（只是给一点手感，松手再展开） */
const UP_DAMPING = 0.25;

/** 拖着的时候面板的位移：往下 1:1；往上能展开时带阻尼，不能时不动 */
export function sheetFollow(dy: number, canExpand: boolean): number {
  if (dy >= 0) return dy;
  return canExpand ? dy * UP_DAMPING : 0;
}

/** 松手时：expand 展开，close 收起，stay 弹回。vy px/ms，height 是面板的高度 */
export function sheetRelease(dy: number, vy: number, height: number, canExpand: boolean): 'expand' | 'close' | 'stay' {
  if (dy < 0) return canExpand ? 'expand' : 'stay';
  return dragDecision(dy, vy, height) ? 'close' : 'stay';
}

export function useSheetDrag(o: {
  /** 跟手移动的那个元素（整张面板） */
  target: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 往上拉展开（看图器的信息面板收起时） */
  onExpand?: () => void;
  /** 这一下能不能开始拖（例如展开时只有把手能拖，里面的内容要滚动） */
  canStart?: (e: PointerEvent<HTMLElement>) => boolean;
}) {
  const latest = useRef(o);
  latest.current = o;
  const drag = useRef<{ y: number; t: number; id: number; active: boolean } | null>(null);
  const draggedAt = useRef(-Infinity);

  const follow = (dy: number, ms = 0) => {
    const el = latest.current.target.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  };

  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || latest.current.canStart?.(e) === false) return;
      drag.current = { y: e.clientY, t: e.timeStamp, id: e.pointerId, active: false };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y;
      if (!d.active) {
        if (Math.abs(dy) < GESTURE.slop) return;
        d.active = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      follow(sheetFollow(dy, !!latest.current.onExpand));
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      drag.current = null;
      if (!d || e.pointerId !== d.id || !d.active) return;
      const dy = e.clientY - d.y;
      const O = latest.current;
      const go = sheetRelease(dy, dy / Math.max(1, e.timeStamp - d.t), O.target.current?.offsetHeight ?? 300, !!O.onExpand);
      draggedAt.current = e.timeStamp;
      // 收起时面板也先回到原位：Sheet 的退场动画、InfoSheet 收成一条都从原位开始
      follow(0, 220);
      if (go === 'expand') O.onExpand?.();
      else if (go === 'close') O.onClose();
    },
    onPointerCancel: () => {
      if (!drag.current) return;
      drag.current = null;
      follow(0, 220);
    },
    onClickCapture: (e: React.MouseEvent) => {
      // 拖过以后浏览器可能还会补一个 click：不然刚展开又收起、或者误按了操作
      if (e.timeStamp - draggedAt.current > 400) return;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}
