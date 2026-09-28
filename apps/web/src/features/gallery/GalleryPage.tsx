import type { ContentKind, LibraryStats } from '@emaki/shared';
import { ArrowRight, FolderPlus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { KindBadge } from '@/components/media/KindBadge';
import { annexTotal, KIND_LABEL } from '@/lib/kinds';
import { KindIndex } from '@/features/annex/KindIndex';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount } from '@/lib/format';
import { useImagesInfinite, useStats } from '@/lib/queries';
import { usePrefs, useSelection } from '@/lib/stores';
import { GalleryToolbar } from './components/GalleryToolbar';
import { GridFooter } from './components/GridStates';
import { SelectionBar } from './components/SelectionBar';
import { useGalleryParams } from './useGalleryParams';

const SCOPE = 'gallery';

/**
 * 图库：浏览插画、批量整理。默认只看插画（D2），截图、漫画等在「别册」；类型在工具条最前面切换。
 * 筛选状态在 URL 里（见 useGalleryParams），多选状态在 useSelection（scope = gallery）。
 */
export function GalleryPage() {
  const { filters, query, update, hasFilters, clearFilters } = useGalleryParams();
  const { data: stats } = useStats();
  const rowHeight = usePrefs((s) => s.gridRowHeight);
  const list = useImagesInfinite(query);
  const images = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const scrollRef = useScrollContainer();
  const navigate = useNavigate();

  // 换筛选：回到顶部，并清空多选（选中的图可能已经不在当前结果里了）
  const queryKey = JSON.stringify(query);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    scrollRef.current?.scrollTo({ top: 0 });
    clearGallerySelection();
  }, [queryKey, scrollRef]);

  // 离开图库时不留下「幽灵选择」
  useEffect(() => clearGallerySelection, []);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const libraryEmpty = stats?.imageCount === 0 && !hasFilters;
  const onlyIllust = Array.isArray(filters.kind) && filters.kind.length === 1 && filters.kind[0] === 'illustration';
  // 混着看好几类时，非插画带类型小标记
  const showKind = !onlyIllust && !(Array.isArray(filters.kind) && filters.kind.length === 1);

  let body: ReactNode;
  if (list.isError && images.length === 0) {
    body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  } else if (list.isPending) {
    body = <ImageGridSkeleton rows={Math.max(3, Math.ceil(900 / rowHeight))} rowHeight={rowHeight} />;
  } else if (images.length === 0) {
    body = libraryEmpty ? (
      <EmptyState
        glyph="画"
        title="图库还是空的"
        description="添加一个存放插画的文件夹，Emaki 会在本地扫描、识别角色并整理它们。图片不会上传到任何地方。"
        action={
          <Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => navigate('/settings')}>
            添加图片文件夹
          </Button>
        }
      />
    ) : (
      <EmptyState
        glyph="无"
        title={filters.q ? `没有找到「${filters.q}」` : `没有符合条件的${kindNoun(filters.kind)}`}
        description={
          filters.q
            ? '可以搜文件名，或 Danbooru 风格的标签，比如 long_hair、smile。'
            : '当前的分级、方向或收藏筛选下没有图片，放宽一些条件试试。'
        }
        action={
          <Button variant="outline" onClick={clearFilters}>
            清除筛选
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <div
          className={cn(
            'transition-opacity duration-300 ease-[var(--ease-out-soft)]',
            // 换筛选时旧结果先留着，淡一点表示「正在更新」
            list.isPlaceholderData && 'pointer-events-none opacity-45',
          )}
        >
          <ImageGrid
            images={images}
            selectionScope={SCOPE}
            hasMore={hasNextPage}
            total={total}
            loadingMore={isFetchingNextPage}
            onLoadMore={loadMore}
            rowHeight={rowHeight}
            renderOverlay={showKind ? (img) => <KindBadge kind={img.kind} /> : undefined}
          />
        </div>
        <GridFooter loadingMore={isFetchingNextPage} done={!hasNextPage} total={total} />
        {onlyIllust && !hasNextPage && annexTotal(stats?.kindCounts) > 0 && (
          <p className="pb-6 text-center text-[12.5px] text-fg-muted">
            另有 {formatCount(annexTotal(stats?.kindCounts))} 张截图、漫画等在{' '}
            <Link to="/annex" className="font-medium text-fg hover:underline">
              别册 →
            </Link>
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        sticky
        title="图库"
        subtitle={
          <Subtitle
            stats={stats}
            kind={filters.kind}
            filtered={hasFilters}
            total={list.isPlaceholderData || list.isPending ? null : total}
          />
        }
      >
        <KindIndex
          current={filters.kind === 'all' ? 'all' : onlyIllust ? 'illustration' : null}
          onGallery={(k) => update({ kind: k === 'all' ? 'all' : ['illustration'] })}
        />
        <div className="mt-3">
          <GalleryToolbar filters={filters} update={update} hasFilters={hasFilters} onClearFilters={clearFilters} />
        </div>
        {onlyIllust && <KindTip annex={annexTotal(stats?.kindCounts)} />}
      </PageHeader>

      <PageBody className="flex-1 pt-2">{body}</PageBody>

      <SelectionBar images={images} scope={SCOPE} />
    </div>
  );
}

const kindNoun = (kind: ContentKind[] | 'all') => (kind === 'all' || kind.length !== 1 ? '图片' : KIND_LABEL[kind[0]!]);

/** 首次提示：图库现在只显示插画（D2）。关掉后不再出现 */
function KindTip({ annex }: { annex: number }) {
  const seen = usePrefs((s) => s.galleryKindTipSeen);
  const dismiss = usePrefs((s) => s.dismissGalleryKindTip);
  if (seen || annex === 0) return null;
  return (
    <div className="mt-3 flex animate-fade-in items-center gap-3 rounded-[10px] bg-sunken/70 px-3.5 py-2 text-[12.5px] text-fg-muted">
      <span className="flex-1">
        图库现在只显示插画。截图、漫画、照片等 {formatCount(annex)} 张收在「别册」里：不删除，只是不计入角色、不进未识别。
      </span>
      <Link to="/annex" className="inline-flex shrink-0 items-center gap-1 font-medium text-fg hover:underline">
        去别册看看 <ArrowRight className="size-3.5" />
      </Link>
      <button type="button" onClick={dismiss} aria-label="知道了" className="shrink-0 rounded-full p-1 hover:bg-hover hover:text-fg">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Subtitle({
  stats,
  kind,
  filtered,
  total,
}: {
  stats: LibraryStats | undefined;
  kind: ContentKind[] | 'all';
  filtered: boolean;
  /** null = 还在加载 */
  total: number | null;
}) {
  if (!stats) return <Skeleton className="mt-1.5 h-3 w-36 rounded-full" />;
  if (filtered) {
    return (
      <span className="animate-fade-in">
        {total === null ? (
          '正在筛选…'
        ) : (
          <>
            筛选出 <span className="font-medium text-fg">{formatCount(total)}</span> 张
          </>
        )}
        <span className="text-fg-subtle"> · 共 {formatCount(stats.imageCount)} 张</span>
      </span>
    );
  }
  if (kind === 'all') {
    return (
      <span>
        全部 {formatCount(stats.imageCount)} 张 · {formatBytes(stats.totalBytes)}
      </span>
    );
  }
  const n = kind.reduce((a, k) => a + stats.kindCounts[k], 0);
  const annex = annexTotal(stats.kindCounts);
  const onlyIllust = kind.length === 1 && kind[0] === 'illustration';
  return (
    <span>
      {formatCount(n)} 张{kind.length === 1 ? KIND_LABEL[kind[0]!] : ''}
      {onlyIllust && annex > 0 && (
        <>
          {' · '}
          <Link to="/annex" className="text-fg-subtle transition-colors hover:text-fg">
            另有 {formatCount(annex)} 张在别册 →
          </Link>
        </>
      )}
    </span>
  );
}

function clearGallerySelection() {
  const sel = useSelection.getState();
  if (sel.scope === SCOPE && sel.ids.size) sel.clear();
}
