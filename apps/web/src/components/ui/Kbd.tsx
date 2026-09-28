import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'inverse'; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 font-sans text-[10.5px] font-semibold tracking-wide',
        tone === 'default' && 'border border-line-strong bg-raised text-fg-muted shadow-[0_1px_0_var(--c-line-strong)]',
        tone === 'inverse' && 'bg-fg-inverse/15 text-fg-inverse',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
