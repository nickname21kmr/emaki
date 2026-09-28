import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './Kbd';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children,
}: {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}) {
  if (!content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[100] flex items-center gap-2 rounded-sm bg-ink px-2 py-1 text-xs font-medium text-fg-inverse shadow-lift data-[state=delayed-open]:animate-fade-in"
        >
          {content}
          {shortcut && <Kbd tone="inverse">{shortcut}</Kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
