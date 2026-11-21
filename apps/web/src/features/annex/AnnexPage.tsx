import { ANNEX_KINDS, type ContentKind } from '@emaki/shared';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { CardGrid, type CardVariant } from '@/components/media/CardGrid';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { KindBadge } from '@/components/media/KindBadge';
import { EmptyState, ErrorState, Segmented, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { ANIMATED_LABEL, KIND_HINT, KIND_LABEL } from '@/lib/kinds';
import { useCollections, useImagesInfinite, useStats } from '@/lib/queries';
import { CollectionShelf } from '@/features/collections/components/Shelf';
import { useSelection } from '@/lib/stores';
import { GalleryToolbar } from '@/features/gallery/components/GalleryToolbar';
import { GridFooter } from '@/features/gallery/components/GridStates';
import { SelectionBar } from '@/features/gallery/components/SelectionBar';
import { useGalleryParams } from '@/features/gallery/useGalleryParams';
import { KindIndex } from './KindIndex';

const SCOPE = 'annex';

/** 每一类用适合它的方式摆（SEL-6）：截图竖卡、文字纸页、表情贴纸；照片、漫画用等高行 */
const LAYOUT: Record<ContentKind, CardVariant | { rowHeight: number }> = {
  illustration: { rowHeight: 240 },
  screenshot: 'shot',
  text: 'page',
  meme: 'sticker',
  photo: { rowHeight: 200 },
  comic: { rowHeight: 220 },
};

/** 别册里的一页：一个别册类型，或者跨类型的「动图」筛选（D5） */
type AnnexScope = ContentKind | 'animated';

/**
 * 别册（T32b）：截图、漫画、文字、照片、表情——不是插画的图收在这里，
 * 不删除、不排除，只是不计入角色、不进未识别。/annex/:kind，不带 kind 时进第一个非空的类型。
 * /annex/animated 不是类型：各类里会动的图（动的插画、动的表情……）都在这里，格子上带类型印，方便一眼看到所有动图（D5）。
 * 页头是目次（和图库共用）+ 图库的工具条（搜索、分级、排序）；分错了：多选后按 C「归入…」改回插画。
 */
export function AnnexPage() {
  const { kind: param } = useParams();
  const { data: stats } = useStats();
  const counts = stats?.kindCounts;
  const scope: AnnexScope | null =
    param === 'animated' ? 'animated' : ANNEX_KINDS.includes(param as ContentKind) ? (param as ContentKind) : null;

  if (!scope) {
    if (!counts) return <AnnexSkeleton />;
    const first = ANNEX_KINDS.find((k) => counts[k] > 0);
    if (first) return <Navigate to={`/annex/${first}`} replace />;
  }
  const count = !stats || !scope ? undefined : scope === 'animated' ? stats.animatedCount : stats.kindCounts[scope];
  return <AnnexView scope={scope} count={count} />;
}

function AnnexView({ scope, count }: { scope: AnnexScope | null; count: number | undefined }) {
  const { filters, query: base, update, hasFilters, clearFilters, customThemes } = useGalleryParams({ ownsKind: false });
  const animatedView = scope === 'animated';
  const kind = animatedView ? null : scope;
  // 漫画分「成册 | 散页」（T38f）：成册看本子书架，散页只看不在合集里的漫画
  const [params, setParams] = useSearchParams();
  const comicView = kind === 'comic' ? (params.get('view') === 'pages' ? 'pages' : 'books') : null;
  const { data: stats } = useStats();
  const books = useCollections({ kind: 'doujin' }, comicView === 'books');
  const query = useMemo(
    () =>
      animatedView
        ? // 动图：全部类型里会动的（不看图库「只看插画」的偏好）
          { ...base, kind: undefined, animated: true }
        : { ...base, kind: [kind ?? ('__none__' as ContentKind)], ...(comicView === 'pages' && { collectionId: 'none' as const }) },
    [base, kind, comicView, animatedView],
  );
  const list = useImagesInfinite(query);
  const images = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const scrollRef = useScrollContainer();

  // 换类型或筛选：回到顶部、清空选择
  const key = JSON.stringify(query);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    const sel = useSelection.getState();
    if (sel.scope === SCOPE && (sel.ids.size || sel.on)) sel.clear();
  }, [key, scrollRef]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  let body: ReactNode;
  if (comicView === 'books') {
    body = !books.data ? (
      <ImageGridSkeleton rows={3} rowHeight={220} />
    ) : books.data.length === 0 ? (
      <EmptyState glyph="本" title="还没有成册的本子" description="漫画页按文件夹自动成册；也可以在看图器里把一个文件夹做成合集。" />
    ) : (
      <CollectionShelf list={books.data} />
    );
  } else if (!scope) {
    body = <EmptyState glyph="净" title="还没有需要分开放的图" description="没有截图、漫画、照片这类不是插画的图。它们出现时会自动收到这里，不计入角色，也不进未识别。" />;
  } else if (list.isError && images.length === 0) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (list.isPending) {
    body = <ImageGridSkeleton rows={5} rowHeight={180} />;
  } else if (images.length === 0) {
    const label = kind ? KIND_LABEL[kind] : ANIMATED_LABEL;
    body = hasFilters ? (
      <EmptyState glyph="无" title={`没有符合条件的${label}`} description="放宽一些筛选条件试试。" />
    ) : (
      <EmptyState glyph="无" title={`没有${label}`} description={kind ? '这一类暂时是空的。' : '还没有认出会动的图。GIF、动画 WebP / PNG 读到帧数后会出现在这里。'} />
    );
  } else {
    // 动图跨类型：等高行，格子左下角带类型印（插画不带）
    const layout = kind ? LAYOUT[kind] : { rowHeight: 200 };
    const common = { images, selectionScope: SCOPE, hasMore: hasNextPage, loadingMore: isFetchingNextPage, onLoadMore: loadMore, total: list.data?.pages[0]?.total };
    body = (
      <>
        <div className={cn('transition-opacity duration-300', list.isPlaceholderData && 'pointer-events-none opacity-45')}>
          {typeof layout === 'string' ? (
            <CardGrid {...common} variant={layout} />
          ) : (
            <ImageGrid {...common} rowHeight={layout.rowHeight} renderBadges={kind ? undefined : (img) => <KindBadge kind={img.kind} />} />
          )}
        </div>
        <GridFooter loadingMore={isFetchingNextPage} done={!hasNextPage} total={list.data?.pages[0]?.total ?? 0} />
      </>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        sticky
        title="别册"
        actions={
          comicView && (
            <Segmented<'books' | 'pages'>
              size="sm"
              value={comicView}
              onChange={(v) =>
                setParams(
                  (p) => {
                    const next = new URLSearchParams(p);
                    if (v === 'books') next.delete('view');
                    else next.set('view', v);
                    return next;
                  },
                  { replace: true },
                )
              }
              options={[
                { value: 'books', label: '成册' },
                { value: 'pages', label: '散页' },
              ]}
            />
          )
        }
        subtitle={
          scope && count !== undefined ? (
            <span>
              {kind ? KIND_LABEL[kind] : ANIMATED_LABEL} ·{' '}
              {kind === 'comic' && stats
                ? `${formatCount(count)} 页 · 其中 ${formatCount(stats.collectionCounts.doujin)} 本成册`
                : kind
                  ? `${formatCount(count)} 张 · ${KIND_HINT[kind]}`
                  : `${formatCount(count)} 张 · 不是类型：各类里会动的图都在这里，按帧数自动认出`}
            </span>
          ) : (
            <Skeleton className="mt-1.5 h-3 w-48 rounded-full" />
          )
        }
      >
        <KindIndex current={scope} />
        {comicView !== 'books' && (
          <div className="mt-3">
            <GalleryToolbar
              filters={filters}
              query={query}
              update={update}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
              customThemes={customThemes}
              animatedChip={!animatedView}
            />
          </div>
        )}
      </PageHeader>
      <PageBody className="flex-1 pt-2">{body}</PageBody>
      <SelectionBar images={images} scope={SCOPE} />
    </div>
  );
}

function AnnexSkeleton() {
  return (
    <div className="px-8 pt-8">
      <Skeleton className="h-8 w-32" />
      <div className="mt-6">
        <ImageGridSkeleton rows={4} rowHeight={180} />
      </div>
    </div>
  );
}
