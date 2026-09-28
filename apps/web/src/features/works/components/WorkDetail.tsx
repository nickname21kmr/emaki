import type { ID } from '@emaki/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageBody } from '@/components/layout/PageHeader';
import { ImageGridSkeleton } from '@/components/media/ImageGrid';
import { CollectionsStrip } from '@/components/media/CollectionsStrip';
import { Thumb } from '@/components/media/Thumb';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useCharactersInfinite, useWork } from '@/lib/queries';
import { DetailHeader } from '@/features/characters/detail/DetailHeader';
import { useInView } from '@/features/characters/detail/useInView';
import { COLLAPSED_COUNT } from './constants';
import { WorkCharacters, WorkCharactersSkeleton } from './WorkCharacters';
import { WorkHero, WorkHeroSkeleton } from './WorkHero';
import { WorkImages } from './WorkImages';

/**
 * 作品页：Hero（染色纸 + 封面）→ 角色书架 → 全部插画。
 * 外层按 id 加 key 挂载，切换作品时局部状态自动重置。
 */
export function WorkDetail({ id }: { id: ID }) {
  const navigate = useNavigate();
  const work = useWork(id);
  const [includeOther, setIncludeOther] = useState(false);
  const chars = useCharactersInfinite({ workId: id, sort: 'imageCount', ...(includeOther && { includeOther: true }) });
  const [expanded, setExpanded] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const heroVisible = useInView(heroRef, { rootMargin: '-72px 0px 0px 0px', enabled: !!work.data });

  const { fetchNextPage } = chars;
  const loadMoreChars = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);

  const allChars = useMemo(() => chars.data?.pages.flatMap((p) => p.items) ?? [], [chars.data]);
  const [visibleChars, setVisibleChars] = useState(0);
  const charTotal = chars.data?.pages[0]?.total ?? work.data?.characterCount ?? 0;

  const w = work.data;
  const header = (
    <DetailHeader
      crumbs={[{ label: '角色', to: `/characters?work=${encodeURIComponent(id)}` }]}
      current={
        w?.name ?? <span className="inline-block h-5 w-28 skeleton rounded-md align-middle" aria-label="加载中" />
      }
      showAvatar={!heroVisible}
      avatar={
        w?.coverImageId ? (
          <Thumb
            image={{ id: w.coverImageId, dominantColor: w.color, rating: w.coverRating }}
            width={240}
            focus={{ x: 0.5, y: 0.3 }}
            className="size-7 rounded-[8px] ring-1 ring-line"
          />
        ) : null
      }
    />
  );

  if (work.isError) {
    const notFound = work.error instanceof ApiRequestError && work.error.code === 'not_found';
    return (
      <>
        {header}
        <PageBody>
          {notFound ? (
            <EmptyState
              glyph="无"
              title="找不到这部作品"
              description="它可能已经被删除，或者链接有误。"
              action={
                <Button variant="primary" size="sm" onClick={() => navigate('/characters')}>
                  回到角色列表
                </Button>
              }
            />
          ) : (
            <ErrorState error={work.error} onRetry={() => void work.refetch()} />
          )}
        </PageBody>
      </>
    );
  }

  if (!w) {
    return (
      <>
        {header}
        <PageBody className="flex flex-col gap-10">
          <WorkHeroSkeleton />
          <WorkCharactersSkeleton />
          <ImagesSkeleton />
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody className="flex flex-col gap-10">
        <WorkHero work={w} heroRef={heroRef} />

        {chars.isPending ? (
          <WorkCharactersSkeleton count={Math.min(Math.max(w.characterCount, 1), COLLAPSED_COUNT)} />
        ) : (
          <WorkCharacters
            characters={allChars}
            total={charTotal}
            onVisibleCount={setVisibleChars}
            otherOnly={chars.data?.pages[0]?.otherOnlyCount ?? 0}
            includeOther={includeOther}
            onIncludeOther={(v) => {
              setIncludeOther(v);
              if (v) setExpanded(true);
            }}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            hasMore={!!chars.hasNextPage}
            loadingMore={chars.isFetchingNextPage}
            onLoadMore={loadMoreChars}
            error={chars.isError ? chars.error : undefined}
            onRetry={() => void chars.refetch()}
          />
        )}

        {!chars.isPending && <CollectionsStrip workId={id} />}

        {/* 角色书架定高之后再挂网格：ImageGrid 挂载时测量自己在滚动容器里的位置 */}
        {chars.isPending ? (
          <ImagesSkeleton />
        ) : (
          <WorkImages workId={id} gridKey={`${expanded ? 'all' : 'top'}-${visibleChars}`} />
        )}
      </PageBody>
    </>
  );
}

function ImagesSkeleton() {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-80 rounded-full" />
      </div>
      <ImageGridSkeleton rows={3} rowHeight={220} />
    </section>
  );
}
