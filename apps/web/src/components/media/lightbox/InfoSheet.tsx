import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { GESTURE, dragDecision } from '@/lib/gestures';

/**
 * 窄屏（宽度 compact / medium，A1）的信息面板：贴在看图器底边的一张纸。
 * 平时只露出一条（收藏、归为原创、排除这一排操作），把手往上拉、点把手或者顶栏的「信息」展开全部信息，往下拉收起；
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
  const start = useRef<{ y: number; t: number } | null>(null);
  // 拖过之后浏览器还会补一个 click：吃掉它，不然刚展开又收起
  const dragged = useRef(false);
  const follow = (dy: number, ms = 0) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms var(--ease-out-soft)` : 'none';
    el.style.transform = dy ? `translateY(${dy}px)` : '';
  };
  return (
    <div
      ref={ref}
      data-lb-chrome
      role="region"
      aria-label="图片信息"
      className={cn(
        // 平板竖屏不铺满 800 宽：信息是按 320 宽排的，拉得太开不好读
        'absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-[20px] bg-sheet text-fg shadow-pop ring-1 ring-line medium:mx-auto medium:max-w-[600px]',
        'transition-[opacity,translate] duration-300 ease-[var(--ease-out-soft)] group-data-returning/lb:opacity-0',
        expanded ? 'max-h-[78%]' : 'max-h-[40%]',
        hidden && 'pointer-events-none translate-y-full opacity-0',
      )}
    >
      {/* 把手：点一下展开 / 收起，上下拖也行 */}
      <button
        type="button"
        aria-label={expanded ? '收起信息' : '展开信息'}
        aria-expanded={expanded}
        onClick={() => {
          if (dragged.current) return void (dragged.current = false);
          onExpandedChange(!expanded);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, t: e.timeStamp };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const dy = e.clientY - s.y;
          // 往下拖跟手；往上拖只给一点阻尼的反馈，松手再展开
          follow(dy > 0 ? dy : dy * 0.25);
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dy = e.clientY - s.y;
          const vy = dy / Math.max(1, e.timeStamp - s.t);
          follow(0, 220);
          if (Math.abs(dy) < GESTURE.slop) return; // 点按交给 onClick
          dragged.current = true;
          if (dy < 0) onExpandedChange(true);
          else if (dragDecision(dy, vy, ref.current?.offsetHeight ?? 300)) onExpandedChange(false);
        }}
        onPointerCancel={() => {
          start.current = null;
          follow(0, 220);
        }}
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
