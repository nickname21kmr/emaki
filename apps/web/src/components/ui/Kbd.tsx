import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * 键帽。触屏上（pointer: coarse，A1）默认不显示：按钮旁边的快捷键、提示条里的「Ctrl Z」在手机、平板上都用不上。
 * 说明快捷键本身的地方（帮助对话框）传 doc，照常显示。整行都是按键说明的提示（「↑↓ 选择 · ↵ 确认」）由那一行自己 touch:hidden
 */
export function Kbd({
  children,
  tone = 'default',
  doc,
  className,
}: {
  children: ReactNode;
  tone?: 'default' | 'inverse';
  /** 这是在说明快捷键（帮助对话框）：触屏上也显示 */
  doc?: boolean;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 font-sans text-[10.5px] font-semibold tracking-wide',
        !doc && 'touch:hidden',
        tone === 'default' && 'border border-line-strong bg-raised text-fg-muted shadow-[0_1px_0_var(--c-line-strong)]',
        tone === 'inverse' && 'bg-fg-inverse/15 text-fg-inverse',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
