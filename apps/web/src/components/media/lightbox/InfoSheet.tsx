import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useSheetDrag } from '@/lib/useSheetDrag';

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
  // 收起时露出的那一整条都能拖（真机上人会在操作那一排上随手一拉，2026-11-19 平板实测）；
  // 展开时只有把手能拖，里面的内容要能滚动。拖的手感和 ui/Sheet 同一份（lib/useSheetDrag）
  const drag = useSheetDrag({
    target: ref,
    onClose: () => onExpandedChange(false),
    onExpand: () => onExpandedChange(true),
    canStart: (e) => !expanded || !!(e.target as Element).closest('[data-sheet-handle]'),
  });
  return (
    <div
      ref={ref}
      data-lb-chrome
      role="region"
      aria-label="图片信息"
      {...drag}
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
