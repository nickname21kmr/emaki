import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * 居中弹窗。用法：
 *   <Dialog open={open} onOpenChange={setOpen} title="新建角色" description="…">
 *     …内容…
 *     <DialogFooter>…按钮…</DialogFooter>
 *   </Dialog>
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 480,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: number;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-scrim/60 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          tabIndex={-1}
          // 打开时优先聚焦第一个输入框；没有输入框就聚焦弹窗本身，
          // 而不是 Radix 默认的第一个按钮（通常是右上角的关闭按钮，键盘打开时会挂一个焦点环）
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const content = e.currentTarget as HTMLElement;
            const field = content.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea, select');
            (field ?? content).focus();
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-64px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
            'rounded-xl bg-raised p-6 shadow-pop ring-1 ring-line outline-none data-[state=open]:animate-rise scrollbar-thin',
            className,
          )}
        >
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-[17px] font-semibold tracking-tight">{title}</D.Title>
              {description ? (
                <D.Description className="mt-1 text-[13px] leading-relaxed text-fg-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === 'string' ? title : ''}</D.Description>
              )}
            </div>
            <D.Close
              aria-label="关闭"
              className="-mt-1 -mr-2 flex size-8 items-center justify-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex items-center justify-end gap-2', className)}>{children}</div>;
}
