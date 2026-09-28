import type { Character } from '@emaki/shared';
import { Pin } from 'lucide-react';
import type { ReactNode } from 'react';
import { CharacterCover } from '@/components/media/CharacterCover';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { primaryWorkName, type WorkIndex } from './works';

// plate 卡片下面有两行图注，行距要大一些
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-7';

/** 书架：竖版 3:4 角色封面的自适应网格 */
export function ShelfGrid({
  items,
  byId,
  showWork = true,
  trailing,
  dimmed,
}: {
  items: Character[];
  byId: WorkIndex;
  /** 分组视图里作品名已经在组标题上了，卡片上不再重复 */
  showWork?: boolean;
  /** 网格末尾追加的格子（「还有 N 位」） */
  trailing?: ReactNode;
  /** 搜索词变化、新结果还没回来时，旧结果稍微变淡 */
  dimmed?: boolean;
}) {
  return (
    <div className={cn(GRID, 'transition-opacity duration-300', dimmed && 'opacity-50')}>
      {items.map((c, i) => (
        <div
          key={c.id}
          className="relative animate-rise"
          // 每页前十几张错开一点浮现，后面的直接出现，避免长列表拖沓
          style={{ animationDelay: `${Math.min(i % 60, 14) * 22}ms` }}
        >
          <CharacterCover character={c} workName={showWork ? primaryWorkName(c, byId) : null} variant="plate" />
          {c.pinned && (
            <span
              title="已置顶"
              className="pointer-events-none absolute top-2.5 left-2.5 flex size-6 items-center justify-center rounded-full bg-black/35 text-white ring-1 ring-white/15 backdrop-blur-md"
            >
              <Pin className="size-3" />
            </span>
          )}
        </div>
      ))}
      {trailing}
    </div>
  );
}


export function ShelfSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="aspect-[3/4] rounded-[14px]" />
      ))}
    </div>
  );
}
