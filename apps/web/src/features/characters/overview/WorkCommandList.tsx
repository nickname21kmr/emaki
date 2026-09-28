import type { ID, Work } from '@emaki/shared';
import { Command } from 'cmdk';
import { Check, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { ChipAvatar } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCompact } from '@/lib/format';
import { workAvatar } from './works';

/**
 * 可搜索的作品列表（cmdk）。「全部作品」弹出框和新建角色里的作品选择器共用。
 * 按名字 / 别名 / Danbooru 标签做子串匹配，前缀命中排前面。
 */
export function WorkCommandList({
  works,
  isSelected,
  onSelect,
  placeholder = '搜索作品…',
  footer,
}: {
  works: Work[];
  isSelected: (id: ID) => boolean;
  onSelect: (id: ID) => void;
  placeholder?: string;
  footer?: ReactNode;
}) {
  return (
    <Command loop filter={filterWorks} className="flex flex-col">
      <div className="flex h-11 items-center gap-2.5 border-b border-line px-3.5">
        <Search className="size-4 shrink-0 text-fg-subtle" />
        <Command.Input
          autoFocus
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <Command.List className="max-h-[min(360px,50vh)] overflow-y-auto overscroll-contain p-1.5 scrollbar-thin">
        <Command.Empty className="py-10 text-center text-[13px] text-fg-muted">没有匹配的作品</Command.Empty>
        {works.map((w) => {
          const selected = isSelected(w.id);
          return (
            <Command.Item
              key={w.id}
              value={w.id}
              keywords={[w.name, ...w.aliases, w.danbooruTag ?? '']}
              onSelect={() => onSelect(w.id)}
              className={cn(
                'flex h-10 cursor-default items-center gap-2.5 rounded-sm px-2 text-[13px] text-fg outline-none select-none',
                'data-[selected=true]:bg-hover',
              )}
            >
              <ChipAvatar image={workAvatar(w)} color={w.color} label={w.name} />
              <span className={cn('min-w-0 flex-1 truncate', selected && 'font-semibold')}>{w.name}</span>
              <span className="shrink-0 text-[11px] text-fg-subtle tabular">
                {w.characterCount} 位 · {formatCompact(w.imageCount)} 张
              </span>
              <span className="flex w-4 shrink-0 justify-end">
                {selected && <Check className="size-3.5 text-shu" />}
              </span>
            </Command.Item>
          );
        })}
      </Command.List>
      {footer && (
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11px] text-fg-subtle">{footer}</div>
      )}
    </Command>
  );
}

function filterWorks(_value: string, search: string, keywords?: string[]): number {
  const s = search.trim().toLowerCase();
  if (!s) return 1;
  let best = 0;
  for (const k of keywords ?? []) {
    const kw = k.toLowerCase();
    if (kw.startsWith(s)) return 1;
    if (kw.includes(s)) best = 0.5;
  }
  return best;
}
