import type { ID } from '@emaki/shared';
import { Plus, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { ChipAvatar } from '@/components/ui';
import { cn } from '@/lib/cn';
import { WorkCommandList } from './WorkCommandList';
import { useWorkIndex, workAvatar } from './works';

/**
 * 新建角色里的「所属作品」：可多选，第一个是主作品。
 * 弹出框用 modal 模式——它挂在 Dialog 外面（Portal），非 modal 时 Dialog 的滚动锁会吃掉列表的滚轮。
 */
export function WorkPicker({ value, onChange }: { value: ID[]; onChange: (v: ID[]) => void }) {
  const { works, byId } = useWorkIndex();
  const [open, setOpen] = useState(false);

  const toggle = (id: ID) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md bg-sunken p-1.5">
      {value.map((id, i) => {
        const w = byId.get(id);
        if (!w) return null;
        return (
          <span
            key={id}
            className="inline-flex h-7 animate-fade-in items-center gap-1.5 rounded-full bg-raised pr-0.5 pl-0.5 text-xs text-fg shadow-[0_0_0_1px_var(--c-line)]"
          >
            <ChipAvatar image={workAvatar(w)} color={w.color} label={w.name} />
            <span className="font-medium">{w.name}</span>
            {i === 0 && value.length > 1 && <span className="text-[10.5px] text-fg-subtle">主作品</span>}
            <button
              type="button"
              aria-label={`移除 ${w.name}`}
              onClick={() => toggle(id)}
              className="flex size-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}

      <Popover.Root open={open} onOpenChange={setOpen} modal>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] transition-colors',
              value.length ? 'text-fg-muted hover:bg-hover hover:text-fg' : 'flex-1 justify-start text-fg-subtle hover:text-fg-muted',
            )}
          >
            <Plus className="size-3.5" />
            {value.length ? '添加作品' : '选择作品（可多选，第一个是主作品）'}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className="z-[70] w-[340px] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg bg-raised shadow-pop ring-1 ring-line data-[state=open]:animate-rise"
          >
            <WorkCommandList works={works} isSelected={(id) => value.includes(id)} onSelect={toggle} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
