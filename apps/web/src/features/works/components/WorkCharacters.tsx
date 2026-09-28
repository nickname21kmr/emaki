import type { Character } from '@emaki/shared';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { AvatarTile } from '@/components/media/AvatarTile';
import { CharacterCover } from '@/components/media/CharacterCover';
import { Badge, Button, EmptyState, ErrorState, SectionTitle, Skeleton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useOnEnterView } from '@/features/characters/detail/useInView';
import { AVATAR_GAP, AVATAR_MIN, TOP_COUNT } from './constants';

const TOP_GRID = 'grid grid-cols-2 gap-4 md:grid-cols-4';
const AVATAR_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-x-4 gap-y-6 justify-items-center';

/**
 * 作品页的「角色」（BR-4）：前 4 位是大卡，其余是圆头像网格。
 * 收起时头像只露整两行（按容器宽度量列数，不留半行空洞）；「展开全部」后无限加载。
 */
export function WorkCharacters({
  characters,
  total,
  expanded,
  onToggle,
  hasMore,
  loadingMore,
  onLoadMore,
  onVisibleCount,
  otherOnly = 0,
  includeOther = false,
  onIncludeOther,
  error,
  onRetry,
}: {
  /** 已加载的全部角色（按张数排好） */
  characters: Character[];
  total: number;
  expanded: boolean;
  onToggle: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** 当前露出来的角色数变了（下方插画网格要重新测量位置） */
  onVisibleCount?: (n: number) => void;
  /** 只在漫画、截图等里出现的角色数（默认不列出） */
  otherOnly?: number;
  includeOther?: boolean;
  onIncludeOther?: (v: boolean) => void;
  error?: unknown;
  onRetry?: () => void;
}) {
  const sentinel = useOnEnterView<HTMLDivElement>(onLoadMore, expanded && hasMore && !loadingMore);
  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(10);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, Math.floor((el.clientWidth + AVATAR_GAP) / (AVATAR_MIN + AVATAR_GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const top = characters.slice(0, TOP_COUNT);
  const rest = characters.slice(TOP_COUNT);
  const collapsedRest = cols * 2;
  const shownRest = expanded ? rest : rest.slice(0, collapsedRest);
  const collapsible = total > TOP_COUNT + collapsedRest;
  const visible = top.length + shownRest.length;
  const onVisibleRef = useRef(onVisibleCount);
  onVisibleRef.current = onVisibleCount;
  useLayoutEffect(() => onVisibleRef.current?.(visible), [visible]);

  return (
    <section aria-label="角色">
      <SectionTitle
        hint={`${formatCount(total)} 位 · 按张数`}
        actions={
          collapsible && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              trailing={<ChevronDown className={cn('size-3.5 transition-transform duration-300', expanded && 'rotate-180')} />}
            >
              {expanded ? '收起' : `展开全部 ${formatCount(total)} 位`}
            </Button>
          )
        }
      >
        角色
      </SectionTitle>

      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : characters.length === 0 ? (
        <EmptyState
          glyph="人"
          title="这部作品还没有角色"
          description="识别出这部作品的角色后，会按张数排在这里。"
          className="py-12"
        />
      ) : (
        <>
          <div className={TOP_GRID}>
            {top.map((c, i) => (
              <div key={c.id} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
                <CharacterCover character={c} size="lg" className="h-[340px]" />
              </div>
            ))}
          </div>
          {/* 头像网格始终挂着（空的也挂），好量列数 */}
          <div ref={gridRef} className={cn(AVATAR_GRID, shownRest.length > 0 && 'mt-8 pt-3.5')}>
            {shownRest.map((c, i) => (
              <div
                key={c.id}
                className="animate-rise"
                style={{ animationDelay: `${Math.min(i % collapsedRest, 20) * 20}ms` }}
              >
                <AvatarTile
                  character={c}
                  caption={`${formatCount(c.imageCount)} 张`}
                  badge={
                    c.newCount > 0 ? (
                      <Badge tone="ink" dot="var(--c-ok)">
                        +{formatCount(c.newCount)}
                      </Badge>
                    ) : undefined
                  }
                />
              </div>
            ))}
          </div>
          {expanded && hasMore && (
            <div ref={sentinel} className="flex h-16 items-center justify-center text-fg-subtle">
              {loadingMore && <Spinner />}
            </div>
          )}
          {(otherOnly > 0 || includeOther) && (expanded || !collapsible) && !hasMore && (
            <div className="pt-6 text-center text-[12.5px] text-fg-muted">
              {includeOther ? '已列出只出现在漫画、截图等里的角色' : `另有 ${formatCount(otherOnly)} 位角色只出现在漫画、截图等里`} ·{' '}
              <button type="button" onClick={() => onIncludeOther?.(!includeOther)} className="font-medium text-fg hover:underline">
                {includeOther ? '隐藏' : '显示'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function WorkCharactersSkeleton({ count = 6 }: { count?: number }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2.5">
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className={TOP_GRID}>
        {Array.from({ length: Math.min(count, TOP_COUNT) }, (_, i) => (
          <Skeleton key={i} className="h-[340px] rounded-[14px]" />
        ))}
      </div>
      {count > TOP_COUNT && (
        <div className={cn(AVATAR_GRID, 'mt-8 pt-3.5')}>
          {Array.from({ length: Math.min(count - TOP_COUNT, 10) }, (_, i) => (
            <Skeleton key={i} className="size-[92px] rounded-full" />
          ))}
        </div>
      )}
    </section>
  );
}
