import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useSheetDrag } from '@/lib/useSheetDrag';

/**
 * 底部面板（A1）：从底边升起的一张纸，圆角朝上，底下让出手势导航条（safe-area）。
 * 手机上的「更多」导航、图库的筛选用它；普通的 Dialog 在宽度 compact 时也排成这个样子（见 Dialog.tsx）。
 * 顶上的把手那一块往下拖（lib/useSheetDrag，和看图器的信息面板同一份）、点遮罩、Esc 都能收起。
 *
 *   <Sheet open={open} onOpenChange={setOpen} title="筛选">…</Sheet>
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  actions,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** 标题右边、关闭按钮左边（例如「清除筛选」） */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag({ target: content, onClose: () => onOpenChange(false) });
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-scrim/60 data-[state=closed]:animate-[fade-in_180ms_ease-in_reverse_both] data-[state=open]:animate-fade-in" />
        <D.Content
          ref={content}
          tabIndex={-1}
          // 不把焦点放到第一个按钮上（触屏上会挂一个焦点环），聚焦面板本身
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.focus();
          }}
          className={cn(
            // 平板竖屏（medium）不铺满 800 宽，和看图器的信息面板一样居中、最宽 600
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-[var(--radius-sheet)] bg-raised shadow-pop ring-1 ring-line outline-none medium:mx-auto medium:max-w-[600px]',
            'pb-[env(safe-area-inset-bottom)] data-[state=closed]:animate-[sheet-up_220ms_var(--ease-out-soft)_reverse_both] data-[state=open]:animate-sheet-up',
            className,
          )}
        >
          <div {...drag} className="shrink-0 touch-none pt-2">
            <div aria-hidden className="mx-auto h-1 w-9 rounded-full bg-line-strong" />
            <div className="flex items-start justify-between gap-3 px-5 pt-3 pb-2">
              <div className="min-w-0">
                <D.Title className="text-[16px] font-semibold tracking-tight">{title}</D.Title>
                {description ? (
                  <D.Description className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</D.Description>
                ) : (
                  <D.Description className="sr-only">{typeof title === 'string' ? title : ''}</D.Description>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <D.Close
                  aria-label="关闭"
                  className="-mt-1 -mr-2 flex size-9 items-center justify-center rounded-md text-fg-subtle touch-hit hover:bg-hover hover:text-fg"
                >
                  <X className="size-4" />
                </D.Close>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 scrollbar-thin">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
