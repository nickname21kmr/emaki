import type { Character, ID, ImageItem } from '@emaki/shared';
import { Heart, HeartOff, ImageUp, UserRoundMinus } from 'lucide-react';
import { useCallback, useMemo, type Ref } from 'react';
import { useNavigate } from 'react-router';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { KindBadge } from '@/components/media/KindBadge';
import { Button, EmptyState, ErrorState } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useImagesInfinite, useMutate } from '@/lib/queries';
import { shouldBlur } from '@/lib/blur';
import { useBlurPrefs, usePrefs } from '@/lib/stores';
import { ImagesToolbar } from './ImagesToolbar';
import { SelectionBar, type SelectionAction } from './SelectionBar';
import { useImageFilters } from './useImageFilters';
import { useScopedSelection } from './useScopedSelection';

/**
 * 角色详情的「全部插画」：工具条 + 虚拟化网格 + 多选操作栏。
 * 多选后可以「从该角色移除」，只选 1 张时还能「设为封面」。
 */
export function CharacterImages({
  character,
  newSinceLastVisit,
  sectionRef,
  dialogOpen,
}: {
  character: Character;
  /** 进入页面时的「+N」：默认排序下给最新的 N 张打上「新」角标 */
  newSinceLastVisit: number;
  sectionRef?: Ref<HTMLElement>;
  /** 有弹窗时暂停本区的快捷键 */
  dialogOpen: boolean;
}) {
  const filters = useImageFilters();
  const blurPrefs = useBlurPrefs();
  const rowHeight = usePrefs((s) => s.gridRowHeight);
  const query = useImagesInfinite({
    characterId: character.id,
    kind: filters.allKinds ? undefined : ['illustration'],
    sort: filters.sort,
    order: filters.order,
    rating: filters.rating.length ? filters.rating : undefined,
    theme: filters.theme,
  });
  const { fetchNextPage } = query;
  // cancelRefetch: false —— 已经在加载下一页时不要重复发请求
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const navigate = useNavigate();

  const images = useMemo<ImageItem[]>(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total;

  const scope = `character:${character.id}`;
  const selection = useScopedSelection(scope, images, dialogOpen);

  // 「新」只在默认视图（最近添加 · 降序 · 不筛分级）下可信：此时最前面的 N 张就是新图
  const newIds = useMemo(() => {
    if (!filters.isDefault || newSinceLastVisit <= 0) return null;
    return new Set(images.slice(0, newSinceLastVisit).map((i) => i.id));
  }, [filters.isDefault, newSinceLastVisit, images]);

  const unassign = useMutate(
    (ids: ID[]) => api.bulkImages({ ids, action: { type: 'unassign', characterId: character.id } }),
    { onSuccess: selection.clear },
  );
  const setCover = useMutate((imageId: ID) => api.updateCharacter(character.id, { coverImageId: imageId }), {
    onSuccess: selection.clear,
  });
  const favorite = useMutate(
    ({ ids, value }: { ids: ID[]; value: boolean }) => api.bulkImages({ ids, action: { type: 'favorite', value } }),
    { onSuccess: selection.clear },
  );

  const byId = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const allFavorite = selection.ids.length > 0 && selection.ids.every((id) => byId.get(id)?.favorite);
  const busy = unassign.isPending || setCover.isPending || favorite.isPending;

  const actions: SelectionAction[] = [
    ...(selection.count === 1
      ? [
          {
            key: 'cover',
            label: '设为封面',
            icon: <ImageUp />,
            loading: setCover.isPending,
            disabled: busy || selection.ids[0] === character.coverImageId,
            onClick: () => selection.ids[0] && setCover.mutate(selection.ids[0]),
          },
        ]
      : []),
    {
      key: 'favorite',
      label: allFavorite ? '取消收藏' : '收藏',
      icon: allFavorite ? <HeartOff /> : <Heart />,
      loading: favorite.isPending,
      disabled: busy,
      onClick: () => favorite.mutate({ ids: selection.ids, value: !allFavorite }),
    },
    {
      key: 'unassign',
      label: '从该角色移除',
      icon: <UserRoundMinus />,
      loading: unassign.isPending,
      disabled: busy,
      onClick: () => unassign.mutate(selection.ids),
    },
  ];

  let body;
  if (query.isPending) {
    body = <ImageGridSkeleton rows={3} rowHeight={Math.min(rowHeight, 260)} />;
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (images.length === 0) {
    body = filters.rating.length || filters.theme ? (
      <EmptyState
        glyph="筛"
        title="没有符合筛选的插画"
        description="换个分级或画面，或者清除筛选看看全部。"
        action={
          <Button variant="secondary" size="sm" onClick={filters.clearFilters}>
            清除筛选
          </Button>
        }
      />
    ) : (
      <EmptyState
        glyph="空"
        title={`${character.name}还没有插画`}
        description="把图片归到这个角色后会出现在这里。可以去「未识别」里快速归类。"
        action={
          <Button variant="primary" size="sm" onClick={() => navigate('/unrecognized')}>
            去归类
          </Button>
        }
      />
    );
  } else {
    body = (
      // 切换排序 / 筛选时旧数据先留着并变淡，避免闪白
      <div className={cn('transition-opacity duration-300', query.isPlaceholderData && 'opacity-50')}>
        <ImageGrid
          images={images}
          selectionScope={scope}
          rowHeight={rowHeight}
          hasMore={query.hasNextPage}
          total={total}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={loadMore}
          renderOverlay={
            newIds || filters.allKinds
              ? (img) => (
                  <>
                    {newIds?.has(img.id) && (
                      <span
                        aria-label="新"
                        className={cn(
                          'pointer-events-none absolute top-2 size-2 rounded-full bg-shu shadow-[0_0_0_2px_rgb(255_255_255/0.85)]',
                          // 模糊图的右上角是模糊标记，朱点往左让开
                          shouldBlur(img, blurPrefs) ? 'right-9' : 'right-2',
                        )}
                      />
                    )}
                    {filters.allKinds && <KindBadge kind={img.kind} />}
                  </>
                )
              : undefined
          }
        />
      </div>
    );
  }

  return (
    <section ref={sectionRef} aria-label="全部插画" className="scroll-mt-24">
      <ImagesToolbar total={total} filters={filters} otherCount={character.otherCount} />
      {body}
      <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
    </section>
  );
}
