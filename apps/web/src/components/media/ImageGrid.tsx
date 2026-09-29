import type { ID, ImageItem } from '@emaki/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Heart } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { useLightbox, useSelection } from '@/lib/stores';
import { justify } from './justify';
import { Thumb } from './Thumb';

export interface ImageGridProps {
  images: ImageItem[];
  /** 选择作用域（例如 `gallery`、`character:c1`）；传了才支持多选 */
  selectionScope?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** 目标行高 */
  rowHeight?: number;
  gap?: number;
  /** 自定义每张图上的叠加层（右下角信息等） */
  renderOverlay?: (image: ImageItem) => ReactNode;
  /** 整个列表的总数（看图器显示「N / 总数」并跨分页翻，BR-B1） */
  total?: number;
  /** 哪些图强制按敏感模糊（没识别过的本子页） */
  forceBlur?: (image: ImageItem) => boolean;
  /** 点击图片的默认行为是打开看图器；传这个可以覆盖 */
  onOpen?: (image: ImageItem, index: number) => void;
}

/**
 * 虚拟化的等高行图片网格 + 无限滚动 + 多选。
 *
 * 交互：
 *   单击 → 打开看图器（已有选中时改为切换选中）
 *   Ctrl/⌘+单击 → 切换选中；Shift+单击 → 连选
 *   悬停左上角圆圈 → 点击即选中
 */
export function ImageGrid({
  images,
  selectionScope,
  hasMore,
  loadingMore,
  onLoadMore,
  rowHeight = 240,
  gap = 6,
  renderOverlay,
  onOpen,
  forceBlur,
  total,
}: ImageGridProps) {
  const { scrollRef, containerRef, width, scrollMargin } = useGridBox();
  const rows = useMemo(() => justify(images, width, rowHeight, gap), [images, width, rowHeight, gap]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.height ?? rowHeight) + gap,
    overscan: 4,
    scrollMargin,
  });

  // 行高变化（窗口缩放 / 缩放滑块）后重新测量
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const { selection, selecting, handleClick, gridId, ids } = useGridInteractions(images, selectionScope, onOpen);
  const favorite = useMutate(({ id, value }: { id: ID; value: boolean }) => api.bulkImages({ ids: [id], action: { type: 'favorite', value } }));

  useLightboxFeed(gridId, ids, { total, hasMore, loadingMore, onLoadMore }, (id) => {
    const at = images.findIndex((i) => i.id === id);
    const row = rows.findIndex((r) => at >= r.start && at < r.start + r.widths.length);
    if (row >= 0) virtualizer.scrollToIndex(row, { align: 'center' });
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= rows.length - 4) onLoadMore?.();
  }, [lastIndex, rows.length, hasMore, loadingMore, onLoadMore]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualRows.map((vr) => {
        const row = rows[vr.index]!;
        return (
          <div
            key={vr.key}
            className="absolute left-0 flex w-full"
            style={{ top: vr.start - scrollMargin, height: row.height, gap }}
          >
            {row.widths.map((w, k) => {
              const index = row.start + k;
              const image = images[index]!;
              const selected = selecting && selection.ids.has(image.id);
              return (
                <Tile
                  key={image.id}
                  image={image}
                  width={w}
                  height={row.height}
                  selected={selected}
                  selectable={!!selectionScope}
                  selecting={selecting}
                  onClick={(e) => handleClick(e, image, index)}
                  onToggle={() => selection.toggle(image.id)}
                  onFavorite={() => favorite.mutate({ id: image.id, value: !image.favorite })}
                  overlay={renderOverlay?.(image)}
                  forceBlur={forceBlur?.(image)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 网格容器的宽度和它在滚动容器里的偏移（给虚拟化用）。
 * 网格上方的内容（头部统计、筛选栏）加载后高度会变，所以滚动时也顺手校准一次偏移；值不变时 React 不会重渲染。
 */
export function useGridBox() {
  const scrollRef = useScrollContainer();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const measureMargin = () =>
      setScrollMargin(Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
    const measure = () => {
      setWidth(el.clientWidth);
      measureMargin();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 上方兄弟元素高度变化也要重算
    if (el.parentElement) ro.observe(el.parentElement);
    scroller.addEventListener('scroll', measureMargin, { passive: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener('scroll', measureMargin);
    };
  }, [scrollRef]);
  return { scrollRef, containerRef, width, scrollMargin };
}

/**
 * 看图器从这个网格打开时（BR-B1）：同步总数和加载更多；翻到已加载的最后 10 张时预先要下一页；
 * 关掉后网格定位到刚才看的那张（已经在视口里就不滚，scrollTo 负责滚到那张所在的行）。
 */
export function useLightboxFeed(
  gridId: string,
  ids: ID[],
  { total, hasMore, loadingMore, onLoadMore }: { total?: number; hasMore?: boolean; loadingMore?: boolean; onLoadMore?: () => void },
  scrollTo: (id: ID) => void,
) {
  const owns = useLightbox((s) => s.open && s.source === gridId);
  const index = useLightbox((s) => (s.open && s.source === gridId ? s.index : -1));
  useEffect(() => {
    if (owns) useLightbox.getState().syncMeta(gridId, { total: total ?? null, hasMore: !!hasMore, loadMore: onLoadMore ?? null });
  }, [owns, gridId, total, hasMore, onLoadMore]);
  useEffect(() => {
    if (index >= 0 && index >= ids.length - 10 && hasMore && !loadingMore) onLoadMore?.();
  }, [index, ids.length, hasMore, loadingMore, onLoadMore]);

  const lastViewed = useRef<ID | null>(null);
  if (index >= 0) lastViewed.current = ids[index] ?? null;
  const scrollRef = useRef(scrollTo);
  scrollRef.current = scrollTo;
  useEffect(() => {
    if (owns || !lastViewed.current) return;
    const id = lastViewed.current;
    lastViewed.current = null;
    const r = document.querySelector(`[data-image-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    if (r && r.top >= 0 && r.bottom <= window.innerHeight) return;
    scrollRef.current(id);
  }, [owns]);
}

/**
 * 网格共用的交互：单击打开看图器（已有选中时改为切换选中）、Ctrl/⌘+单击切换、Shift+单击连选；
 * 看图器打开时，网格加载了更多就同步过去（只同步打开看图器的那个网格）。
 */
export function useGridInteractions(images: ImageItem[], selectionScope?: string, onOpen?: (image: ImageItem, index: number) => void) {
  const ids = useMemo(() => images.map((i) => i.id), [images]);
  const gridId = useId();
  const syncLightbox = useLightbox((s) => s.syncIds);
  useEffect(() => syncLightbox(ids, gridId), [ids, gridId, syncLightbox]);

  const selection = useSelection();
  useEffect(() => {
    if (selectionScope) selection.setScope(selectionScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionScope]);
  const selecting = !!selectionScope && selection.scope === selectionScope && selection.ids.size > 0;
  const showLightbox = useLightbox((s) => s.show);

  const handleClick = (e: React.MouseEvent, image: ImageItem, index: number) => {
    if (selectionScope) {
      if (e.shiftKey) return selection.selectRange(ids, image.id);
      if (e.ctrlKey || e.metaKey || selecting) return selection.toggle(image.id);
    }
    if (onOpen) onOpen(image, index);
    else {
      // 从格子里「拿起」（SEL-12）
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showLightbox(ids, index, gridId, { left: r.left, top: r.top, width: r.width, height: r.height, thumb: gridThumbWidth(r.width) });
    }
  };
  return { selection, selecting, handleClick, gridId, ids };
}

/** 左上角的勾选圈（ImageGrid、CardGrid 共用） */
export function SelectCircle({ selected, selecting, onToggle }: { selected: boolean; selecting: boolean; onToggle: () => void }) {
  // 选中那一下放一圈涟漪（SEL-10）；动画结束就卸载
  const [ripple, setRipple] = useState(0);
  const was = useRef(selected);
  useEffect(() => {
    if (selected && !was.current) setRipple(Date.now());
    was.current = selected;
  }, [selected]);
  return (
    <>
    {ripple > 0 && (
      <span
        key={ripple}
        aria-hidden
        onAnimationEnd={() => setRipple(0)}
        className="pointer-events-none absolute top-2 left-2 z-[1] size-6 rounded-full border-2 border-shu motion-safe:animate-[ripple_420ms_var(--ease-out-soft)_forwards] motion-reduce:hidden"
      />
    )}
    <button
      type="button"
      aria-label={selected ? '取消选择' : '选择'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'absolute top-2 left-2 z-[2] flex size-6 items-center justify-center rounded-full transition-all duration-200',
        selected
          ? 'bg-shu text-white opacity-100 motion-safe:animate-[check-in_260ms_var(--ease-out-soft)]'
          : 'bg-black/30 text-transparent opacity-0 ring-2 ring-white/90 group-hover/tile:opacity-100 hover:bg-black/40 hover:text-white/80',
        selecting && !selected && 'opacity-100',
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
    </>
  );
}

/** 装裱内框：外面一道纸色细边、里面一道朱边（SEL-10） */
export function MountFrame({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-[1] rounded-[inherit] shadow-[inset_0_0_0_2px_var(--c-sheet),inset_0_0_0_5px_var(--c-shu)] transition-opacity duration-150',
        selected ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

function Tile({
  image,
  width,
  height,
  selected,
  selectable,
  selecting,
  onClick,
  onToggle,
  overlay,
  forceBlur,
  onFavorite,
}: {
  image: ImageItem;
  width: number;
  height: number;
  selected: boolean;
  selectable: boolean;
  selecting: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  overlay?: ReactNode;
  forceBlur?: boolean;
  onFavorite: () => void;
}) {
  const thumbWidth = gridThumbWidth(width);
  return (
    <div
      className={cn(
        'group/tile group/reveal relative shrink-0 overflow-hidden rounded-[var(--radius-plate-sm)] transition-[scale,box-shadow,translate] duration-[280ms] ease-[var(--ease-out-soft)] hover:z-10',
        selected ? 'motion-safe:scale-[.955]' : 'hover:-translate-y-0.5 hover:shadow-lift',
      )}
      style={{ width, height }}
      data-image-id={image.id}
    >
      <button
        type="button"
        onClick={onClick}
        // 格子本身 overflow-hidden，印框放不下：聚焦时画一道内嵌朱框（SEL-15）
        className="block size-full cursor-zoom-in focus-visible:outline-offset-[-4px]"
        aria-label={image.fileName}
      >
        <Thumb
          image={image}
          width={thumbWidth}
          className="size-full"
          blurBadge="corner"
          revealOnHover
          forceBlur={forceBlur}
          imgClassName="group-hover/tile:scale-[1.03]"
        />
      </button>

      {/* 悬停：底部渐变 + 这是谁（BR-5）；多选时和窄格子不显示 */}
      {!selecting && width >= 120 && height >= 120 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t from-black/55 via-black/20 to-transparent opacity-0 transition-opacity duration-300 group-hover/tile:opacity-100">
          <span
            className={cn(
              'absolute right-10 bottom-2 left-2.5 truncate text-[12px] font-medium drop-shadow-[0_1px_2px_rgb(0_0_0/0.4)]',
              image.characterNames.length ? 'text-white' : 'text-white/70',
            )}
          >
            {image.characterNames.length
              ? image.characterNames.slice(0, 2).join('、') + (image.characterNames.length > 2 ? ` 等 ${image.characterNames.length} 位` : '')
              : image.original
                ? '原创'
                : image.kind === 'illustration' || image.kind === 'comic'
                  ? '未识别'
                  : ''}
          </span>
        </div>
      )}
      {!selecting && (
        <button
          type="button"
          aria-label={image.favorite ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
          className={cn(
            'absolute right-1.5 bottom-1.5 z-10 flex size-7 items-center justify-center rounded-full text-white transition-[opacity,scale] duration-200 active:scale-90 [&_svg]:size-4 [&_svg]:drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]',
            image.favorite ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
          )}
        >
          <Heart className={cn(image.favorite && 'fill-white')} />
        </button>
      )}
      {overlay}

      <MountFrame selected={selected} />
      {selectable && <SelectCircle selected={selected} selecting={selecting} onToggle={onToggle} />}
    </div>
  );
}

/** 网格加载中的骨架 */
export function ImageGridSkeleton({ rows = 3, rowHeight = 240 }: { rows?: number; rowHeight?: number }) {
  const widths = [[1.4, 0.7, 1, 1.5, 0.75], [0.7, 1.8, 0.75, 1], [1, 0.7, 1.3, 0.75, 1.1]];
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-1.5" style={{ height: rowHeight }}>
          {widths[r % widths.length]!.map((f, i) => (
            <div key={i} className="skeleton rounded-[var(--radius-plate-sm)]" style={{ flex: f }} />
          ))}
        </div>
      ))}
    </div>
  );
}


/** 网格格子按实际像素宽度选缩略图档位 */
function gridThumbWidth(width: number): 240 | 480 | 960 {
  const px = width * (window.devicePixelRatio || 1);
  return px > 480 ? 960 : px > 240 ? 480 : 240;
}
