import type { DuplicateGroup } from '@emaki/shared';
import { Equal } from 'lucide-react';
import { Thumb } from '@/components/media/Thumb';
import { Badge } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useIncremental } from '../useIncremental';
import { kindLabel, tileRatio } from '../utils';

/** 每批显示几组：卡片小（最多四张缩略图），一批放够两三屏 */
const STEP = 60;

/**
 * 「已处理」视图：只读的回看列表，紧凑卡片网格。
 * 处理过的组只增不减（真实库有几千组）：照待处理列表的做法分批显示，滚到底附近再加一批，不一次挂上十几万个节点。
 */
export function ResolvedGroups({ groups }: { groups: DuplicateGroup[] }) {
  const { count, hasMore, sentinelRef } = useIncremental(groups.length, STEP);
  return (
    <>
      <div className="grid animate-fade-in grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {groups.slice(0, count).map((g) => (
          <ResolvedCard key={g.id} group={g} />
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} className="h-px" aria-hidden />}
    </>
  );
}

function ResolvedCard({ group }: { group: DuplicateGroup }) {
  const shown = group.images.slice(0, 4);
  const rest = group.images.length - shown.length;
  const keep = group.images.find((i) => i.id === group.suggestedKeepId) ?? group.images[0];

  return (
    <article className="group/res rounded-[16px] bg-raised p-3 ring-1 ring-line transition-shadow duration-300 hover:ring-line-strong">
      <div className="relative flex h-28 gap-1.5">
        {shown.map((img) => (
          <div key={img.id} className="min-w-0 overflow-hidden rounded-[8px]" style={{ flex: `${tileRatio(img)} 1 0%` }}>
            <Thumb
              image={img}
              width={240}
              className="size-full opacity-80 transition-opacity duration-300 group-hover/res:opacity-100"
            />
          </div>
        ))}
        {rest > 0 && (
          <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-md tabular">
            +{rest}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 px-1">
        <Badge tone={group.kind === 'exact' ? 'ok' : 'neutral'}>
          {group.kind === 'exact' && <Equal className="size-3" strokeWidth={2.5} />}
          {kindLabel(group)}
        </Badge>
        <span className="text-[12px] text-fg-muted tabular">{formatCount(group.images.length)} 张</span>
        {keep && (
          <span className="ml-auto min-w-0 truncate text-[12px] text-fg-subtle" title={keep.relPath}>
            {keep.fileName}
          </span>
        )}
      </div>
    </article>
  );
}

/** 已处理视图的骨架，和上面的卡片同尺寸 */
export function ResolvedGroupsSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="rounded-[16px] bg-raised p-3 ring-1 ring-line">
          <div className="flex h-28 gap-1.5">
            <div className="skeleton flex-[0.8] rounded-[8px]" />
            <div className="skeleton flex-[0.8] rounded-[8px]" />
            {i % 2 === 0 && <div className="skeleton flex-[0.8] rounded-[8px]" />}
          </div>
          <div className="mt-3 flex items-center gap-2 px-1">
            <div className="skeleton h-5 w-16 rounded-full" />
            <div className="skeleton h-3 w-8 rounded-sm" />
            <div className="skeleton ml-auto h-3 w-24 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
