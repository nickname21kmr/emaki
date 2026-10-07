import type { ID, ImageItem } from '@emaki/shared';
import { EyeOff, Heart, HeartOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { Button, EmptyState, ErrorState, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { themeQuery } from '@/lib/customTheme';
import { useImagesInfinite, useMutate, useWork } from '@/lib/queries';
import { KindBadge } from '@/components/media/KindBadge';
import { usePrefs } from '@/lib/stores';
import { ImagesToolbar } from '@/features/characters/detail/ImagesToolbar';
import { SelectionBar, type SelectionAction } from '@/features/characters/detail/SelectionBar';
import { useImageFilters } from '@/features/characters/detail/useImageFilters';
import { useScopedSelection } from '@/features/characters/detail/useScopedSelection';

/**
 * 作品页的「全部插画」：和角色详情同一套工具条 / 网格 / 多选栏。
 * 多选操作比角色页少：收藏、排除（归类请去角色页或图库）。
 *
 * gridKey：网格上方的内容高度变化（角色书架展开 / 收起）时换 key，
 * 让 ImageGrid 重新测量它在滚动容器里的偏移，虚拟化窗口才不会错位。
 */
export function WorkImages({ workId, gridKey, dialogOpen = false }: { workId: ID; gridKey: string; dialogOpen?: boolean }) {
  const filters = useImageFilters();
  const work = useWork(workId).data;
  const otherCount = work?.otherCount ?? 0;
  // 「原创」作品：可以只看自己归为原创的，或者只看其余的（识别器认出的、原创角色下的）
  const isOriginal = work?.danbooruTag === 'original';
  const [source, setSource] = useState<'all' | 'mine' | 'rest'>('all');
  const original = isOriginal && source !== 'all' ? source === 'mine' : undefined;
  const rowHeight = usePrefs((s) => s.gridRowHeight);
  const query = useImagesInfinite({
    workId,
    kind: filters.allKinds ? undefined : ['illustration'],
    sort: filters.sort,
    order: filters.order,
    rating: filters.rating.length ? filters.rating : undefined,
    theme: filters.theme,
    ...themeQuery(filters.custom),
    original,
  });
  const { fetchNextPage } = query;
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);

  const images = useMemo<ImageItem[]>(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total;

  const scope = `work:${workId}`;
  const selection = useScopedSelection(scope, images, dialogOpen);

  const favorite = useMutate(
    ({ ids, value }: { ids: ID[]; value: boolean }) => api.bulkImages({ ids, action: { type: 'favorite', value } }),
    { onSuccess: selection.clear },
  );
  const exclude = useMutate((ids: ID[]) => api.bulkImages({ ids, action: { type: 'exclude' } }), {
    onSuccess: selection.clear,
  });

  const byId = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const allFavorite = selection.ids.length > 0 && selection.ids.every((id) => byId.get(id)?.favorite);
  const busy = favorite.isPending || exclude.isPending;

  const actions: SelectionAction[] = [
    {
      key: 'favorite',
      label: allFavorite ? '取消收藏' : '收藏',
      icon: allFavorite ? <HeartOff /> : <Heart />,
      loading: favorite.isPending,
      disabled: busy,
      onClick: () => favorite.mutate({ ids: selection.ids, value: !allFavorite }),
    },
    {
      key: 'exclude',
      label: '排除',
      icon: <EyeOff />,
      loading: exclude.isPending,
      disabled: busy,
      onClick: () => exclude.mutate(selection.ids),
    },
  ];

  let body;
  if (query.isPending) {
    body = <ImageGridSkeleton rows={3} rowHeight={Math.min(rowHeight, 260)} />;
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (images.length === 0) {
    body = filters.rating.length || filters.theme || filters.custom || original !== undefined ? (
      <EmptyState
        glyph="筛"
        title="没有符合筛选的插画"
        description="换个分级或画面，或者清除筛选看看全部。"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              filters.clearFilters();
              setSource('all');
            }}
          >
            清除筛选
          </Button>
        }
      />
    ) : (
      <EmptyState glyph="空" title="这部作品还没有插画" description="归到这部作品角色下的图片会出现在这里。" />
    );
  } else {
    body = (
      <div className={cn('transition-opacity duration-300', query.isPlaceholderData && 'opacity-50')}>
        <ImageGrid
          key={gridKey}
          images={images}
          selectionScope={scope}
          rowHeight={rowHeight}
          hasMore={query.hasNextPage}
          total={total}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={loadMore}
          renderOverlay={filters.allKinds ? (img) => <KindBadge kind={img.kind} /> : undefined}
        />
      </div>
    );
  }

  return (
    <section aria-label="全部插画">
      {isOriginal && (
        <div className="mb-3 flex items-center gap-3">
          <Segmented<'all' | 'mine' | 'rest'>
            size="sm"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: '全部' },
              { value: 'mine', label: '我归为原创的' },
              { value: 'rest', label: '其余' },
            ]}
          />
          <span className="text-[12px] text-fg-subtle">
            {source === 'mine' ? '在未识别或看大图里归为原创的图' : source === 'rest' ? '识别器认出的原创图，和原创角色下的图' : null}
          </span>
        </div>
      )}
      <ImagesToolbar total={total} filters={filters} otherCount={otherCount} />
      {body}
      <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
    </section>
  );
}
