import type { Character } from '@emaki/shared';
import { ChevronRight, Pin } from 'lucide-react';
import { Link } from 'react-router';
import { Thumb } from '@/components/media/Thumb';
import { Badge, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, formatRelative } from '@/lib/format';
import type { WorkIndex } from './works';

/*
 * 列表视图：表格样式的行。
 * 列：封面 · 名字+别名 · 作品 · 张数 · 最近添加 · Danbooru 标签
 * 窄屏只保留前四列。
 */
const COLS = cn(
  'grid items-center gap-x-4',
  'grid-cols-[40px_minmax(0,1fr)_minmax(0,9rem)_4.5rem_14px]',
  'lg:grid-cols-[40px_minmax(0,2fr)_minmax(0,1.2fr)_5rem_6.5rem_minmax(0,1.5fr)_14px]',
);

/** 列标题（放在吸顶条里，滚动时一直可见） */
export function ListHeader() {
  return (
    <div className={cn(COLS, '-mx-3 h-8 px-3 text-[11.5px] font-medium text-fg-subtle')}>
      <span />
      <span>角色</span>
      <span>作品</span>
      <span className="text-right">张数</span>
      <span className="hidden lg:block">最近添加</span>
      <span className="hidden lg:block">Danbooru 标签</span>
      <span />
    </div>
  );
}

export function CharacterRows({ items, byId, dimmed }: { items: Character[]; byId: WorkIndex; dimmed?: boolean }) {
  const now = Date.now();
  return (
    <div className={cn('-mx-3 transition-opacity duration-300', dimmed && 'opacity-50')}>
      {items.map((c, i) => (
        <Row key={c.id} character={c} byId={byId} now={now} index={i} />
      ))}
    </div>
  );
}

function Row({ character: c, byId, now, index }: { character: Character; byId: WorkIndex; now: number; index: number }) {
  const works = c.workIds.map((id) => byId.get(id)).filter((w) => w !== undefined);
  const main = works[0];
  return (
    <Link
      to={`/characters/${c.id}`}
      className={cn(
        COLS,
        'group/row h-[60px] rounded-lg px-3 animate-fade-in',
        'transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]',
      )}
      style={{ animationDelay: `${Math.min(index % 60, 16) * 14}ms` }}
    >
      {/* 封面 */}
      <span className="relative size-10 overflow-hidden rounded-[10px] bg-sunken ring-1 ring-line">
        {c.coverImageId ? (
          <Thumb
            image={{ id: c.coverImageId, dominantColor: 'var(--c-sunken)', rating: c.coverRating }}
            width={240}
            focus={c.coverFocus}
            className="size-full"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-sm font-semibold text-fg-subtle">
            {c.name.slice(0, 1)}
          </span>
        )}
      </span>

      {/* 名字 + 别名 */}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{c.name}</span>
          {c.pinned && <Pin className="size-3 shrink-0 text-fg-subtle" aria-label="已置顶" />}
        </span>
        {c.aliases.length > 0 && (
          <span className="mt-0.5 block truncate text-xs text-fg-subtle">{c.aliases.join(' · ')}</span>
        )}
      </span>

      {/* 作品：主作品 + 其余数量 */}
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted">
        {main ? (
          <>
            <span className="size-2 shrink-0 rounded-full" style={{ background: main.color }} />
            <span className="truncate">{main.name}</span>
            {works.length > 1 && <span className="shrink-0 text-[11px] text-fg-subtle">+{works.length - 1}</span>}
          </>
        ) : (
          <span className="text-fg-subtle">—</span>
        )}
      </span>

      {/* 张数 + 新图 */}
      <span className="flex flex-col items-end">
        <span className="text-sm font-medium text-fg tabular">{formatCount(c.imageCount)}</span>
        {c.newCount > 0 && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ok tabular">
            <span className="size-1.5 rounded-full bg-ok" />+{formatCount(c.newCount)}
          </span>
        )}
      </span>

      {/* 最近添加 */}
      <span className="hidden text-[13px] text-fg-muted tabular lg:block">{formatRelative(c.lastAddedAt, now)}</span>

      {/* Danbooru 标签 */}
      <span className="hidden min-w-0 lg:block">
        {c.danbooruTag ? (
          <span className="block truncate font-mono text-xs text-fg-muted" title={c.danbooruTag}>
            {c.danbooruTag}
          </span>
        ) : (
          <Badge>自建</Badge>
        )}
      </span>

      <ChevronRight className="size-3.5 text-fg-subtle opacity-0 transition-[opacity,transform] duration-200 group-hover/row:translate-x-0.5 group-hover/row:opacity-100" />
    </Link>
  );
}

export function ListSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="-mx-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn(COLS, 'h-[60px] px-3')}>
          <Skeleton className="size-10 rounded-[10px]" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="ml-auto h-3.5 w-10" />
          <Skeleton className="hidden h-3.5 w-16 lg:block" />
          <Skeleton className="hidden h-3.5 w-36 lg:block" />
          <span />
        </div>
      ))}
    </div>
  );
}
