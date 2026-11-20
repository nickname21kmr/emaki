import { useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { GESTURE, dragDecision } from '@/lib/gestures';

/**
 * 窄屏（宽度 compact / medium，A1）的信息面板：贴在看图器底边的一张纸。
 * 平时只露出一条（收藏、归为原创、排除这一排操作），在这一条上往上拉、点把手或者顶栏的「信息」展开全部信息，把手往下拉收起；
 * 单击图片切换界面时整张藏起来。宽屏还是右边的侧栏（Lightbox.tsx）。
 */
export function InfoSheet({
  expanded,
  onExpandedChange,
  hidden,
  children,
}: {
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  /** 界面藏起来了（单击图片 / 放映时鼠标停了） */
  hidden: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 一次触摸：起点、时间；过了 slop 才算拖（active），之前的点按照常交给里面的按钮
  const drag = useRef<{ y: number; t: number; id: number; active: boolean } | null>(null);
  // 拖过之后浏览器可能还会补一个 click：吃掉紧跟着的那一个，不然刚展开又收起、或者误按了操作
  const draggedAt = useRef(-Infinity);
  const follow = (dy: number, ms = 0) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  };
  // 收起时露出的那一整条都能拖（真机上人会在操作那一排上随手一拉，2026-11-19 平板实测）；
  // 展开时只有把手能拖，里面的内容要能滚动
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return;
    if (expanded && !(e.target as Element).closest('[data-sheet-handle]')) return;
    drag.current = { y: e.clientY, t: e.timeStamp, id: e.pointerId, active: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) < GESTURE.slop) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    // 往下拖跟手；往上拖只给一点阻尼的反馈，松手再展开
    follow(dy > 0 ? dy : dy * 0.25);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || e.pointerId !== d.id || !d.active) return;
    const dy = e.clientY - d.y;
    const vy = dy / Math.max(1, e.timeStamp - d.t);
    follow(0, 220);
    draggedAt.current = e.timeStamp;
    if (dy < 0) onExpandedChange(true);
    else if (dragDecision(dy, vy, ref.current?.offsetHeight ?? 300)) onExpandedChange(false);
  };
  return (
    <div
      ref={ref}
      data-lb-chrome
      role="region"
      aria-label="图片信息"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        follow(0, 220);
      }}
      onClickCapture={(e) => {
        if (e.timeStamp - draggedAt.current > 400) return;
        e.stopPropagation();
        e.preventDefault();
      }}
      className={cn(
        // 平板竖屏不铺满 800 宽：信息是按 320 宽排的，拉得太开不好读
        'absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-[20px] bg-sheet text-fg shadow-pop ring-1 ring-line medium:mx-auto medium:max-w-[600px]',
        'transition-[opacity,translate] duration-300 ease-[var(--ease-out-soft)] group-data-returning/lb:opacity-0',
        expanded ? 'max-h-[78%]' : 'max-h-[40%] touch-none',
        hidden && 'pointer-events-none translate-y-full opacity-0',
      )}
    >
      {/* 把手：点一下展开 / 收起，上下拖也行 */}
      <button
        type="button"
        data-sheet-handle
        aria-label={expanded ? '收起信息' : '展开信息'}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        className="flex h-6 shrink-0 touch-none items-center justify-center outline-none"
      >
        <span aria-hidden className="h-1 w-9 rounded-full bg-line-strong" />
      </button>
      <div
        className={cn(
          'min-h-0 flex-1 overscroll-contain pb-[env(safe-area-inset-bottom)] scrollbar-thin',
          expanded ? 'overflow-y-auto' : 'overflow-hidden',
        )}
      >
        {children}
      </div>
    </div>
  );
}
