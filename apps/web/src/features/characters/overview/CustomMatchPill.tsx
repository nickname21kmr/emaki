import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';

/**
 * 头部右侧的淡色胶囊「1 个自建角色能对上 Danbooru」。
 * 点一下只看自建角色（?source=custom），再点一下取消。朱色只用在那个小圆点上。
 */
export function CustomMatchPill({
  count,
  active,
  onToggle,
}: {
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  if (count <= 0 && !active) return null;
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        'inline-flex h-9 animate-fade-in items-center gap-2 rounded-full pr-3 pl-3.5 text-[13px] whitespace-nowrap transition-colors duration-200',
        active ? 'bg-shu-soft text-shu-fg' : 'bg-sunken text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      <span className="relative flex size-1.5">
        {!active && <span className="absolute inset-0 animate-ping rounded-full bg-shu opacity-40 [animation-iteration-count:3]" />}
        <span className="relative size-1.5 rounded-full bg-shu" />
      </span>
      {count > 0 ? (
        <span>
          <span className={cn('font-semibold tabular', !active && 'text-fg')}>{formatCount(count)}</span> 个自建角色能对上 Danbooru
        </span>
      ) : (
        <span>只看自建角色</span>
      )}
      {active && <X className="size-3.5 opacity-70" />}
    </button>
  );
}
