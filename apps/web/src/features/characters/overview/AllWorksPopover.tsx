import type { ID, Work } from '@emaki/shared';
import { ChevronDown } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { Kbd } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { WorkCommandList } from './WorkCommandList';

/** chip 行末尾固定的「全部作品 433 ⌄」：列出所有作品，可搜索。 */
export function AllWorksPopover({
  works,
  total,
  selected,
  onSelect,
}: {
  works: Work[];
  total: number | undefined;
  selected: ID | null;
  onSelect: (id: ID) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className={cn(
            'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-3.5 text-[13px] font-medium whitespace-nowrap select-none',
            'bg-raised text-fg shadow-[0_0_0_1px_var(--c-line)] transition-[background-color,box-shadow] duration-200',
            'hover:bg-hover hover:shadow-[0_0_0_1px_var(--c-line-strong)] data-[state=open]:shadow-[0_0_0_1px_var(--c-line-strong)]',
          )}
        >
          全部作品
          {total !== undefined && <span className="text-[11px] text-fg-subtle tabular">{formatCount(total)}</span>}
          <ChevronDown className="size-3.5 text-fg-muted transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="z-[60] w-[360px] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg bg-raised shadow-pop ring-1 ring-line data-[state=open]:animate-rise"
        >
          <WorkCommandList
            works={works}
            isSelected={(id) => id === selected}
            onSelect={(id) => {
              onSelect(id);
              setOpen(false);
            }}
            placeholder="搜索作品（名字、别名、英文都可以）"
            footer={
              <>
                <span className="inline-flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> 选择
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>↵</Kbd> 切换
                </span>
                <span className="ml-auto inline-flex items-center gap-1">
                  <Kbd>[</Kbd>
                  <Kbd>]</Kbd> 上一部 / 下一部
                </span>
              </>
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
