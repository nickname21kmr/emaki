import type { ID, ImageItem } from '@emaki/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, CheckCheck, Heart } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { isSelecting, useLightbox, useSelection } from '@/lib/stores';
import { pickRevealed } from '@/lib/undoPlace';
import { GroupBadge, selectionIds, toggleImageSelection } from './CollectionControls';
import { TileMarks } from './KindBadge';
import { useUndoRevealTarget } from '@/lib/useUndoReveal';
import { justify } from './justify';
import { Thumb } from './Thumb';
import type { BlurContext } from '@/lib/blur';
import { useCan } from '@/lib/capabilities';
import { Button } from '@/components/ui';
import { useLongPress } from '@/lib/useLongPress';
import { balancedRows, gridGap, gridRowHeight, useViewport } from '@/lib/viewport';

const NO_FLASH: ReadonlySet<ID> = new Set();

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
  /** 自定义每张图上的叠加层（自己定位，例如右上角的「新」点） */
  renderOverlay?: (image: ImageItem) => ReactNode;
  /** 左下角的小标记（类型印、合集页码，不用定位）：和动图标记排成一行，悬停显示角色名时淡出 */
  renderBadges?: (image: ImageItem) => ReactNode;
  /** 整个列表的总数（看图器显示「N / 总数」并跨分页翻，BR-B1） */
  total?: number;
  /** 每张的分级可不可信（识别过没有）；和 blurContext 一起决定模糊（共用的 blurReason，附录 #30） */
  rated?: (image: ImageItem) => boolean;
  /** 展示场合：本子页是 cautious（分级不可信就打码，bookBlurContext），默认 browse */
  blurContext?: BlurContext;
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
  renderBadges,
  onOpen,
  rated,
  blurContext,
  total,
}: ImageGridProps) {
  const { scrollRef, containerRef, width, scrollMargin } = useGridBox();
  // 目标行高和缝按窗口分级缩放（lib/viewport.ts 的 gridRowHeight：手机竖屏约 140、平板竖屏约 180，宽屏照用户的设置）
  const viewport = useViewport();
  const target = gridRowHeight(viewport, rowHeight);
  const g = gridGap(viewport, gap);
  const balance = balancedRows(viewport);
  const rows = useMemo(() => justify(images, width, target, g, { balance }), [images, width, target, g, balance]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.height ?? target) + g,
    overscan: 4,
    scrollMargin,
  });

  // 行高变化（窗口缩放 / 缩放滑块）后重新测量
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const { selection, selecting, handleClick, gridId, ids } = useGridInteractions(images, selectionScope, onOpen);
  const favorite = useMutate(({ ids, value }: { ids: ID[]; value: boolean }) => api.bulkImages({ ids, action: { type: 'favorite', value } }));
  // 收藏要 curate（lib/capabilities.ts）：没有的设备上格子里只显示已收藏的心，点不了
  const canFavorite = useCan('curate');

  useLightboxFeed(gridId, ids, { total, hasMore, loadingMore, onLoadMore }, (id) => {
    const at = images.findIndex((i) => selectionIds(i).includes(id));
    const row = rows.findIndex((r) => at >= r.start && at < r.start + r.widths.length);
    if (row >= 0) virtualizer.scrollToIndex(row, { align: 'center' });
  });

  // 在这一页撤销了一步：撤回来的图在网格里就滚过去，描一下朱框
  const { reveal, done: revealDone } = useUndoRevealTarget();
  const [flash, setFlash] = useState<ReadonlySet<ID>>(NO_FLASH);
  const flashTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => {
    const want = reveal?.focus.images;
    if (!want?.length || !rows.length) return;
    const hit = pickRevealed(ids, want);
    if (!hit) return;
    const row = rows.findIndex((r) => hit.index >= r.start && hit.index < r.start + r.widths.length);
    if (row >= 0) virtualizer.scrollToIndex(row, { align: 'center' });
    setFlash(new Set(want));
    revealDone();
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(NO_FLASH), 1600);
  }, [reveal, ids, rows, virtualizer, revealDone]);

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
            style={{ top: vr.start - scrollMargin, height: row.height, gap: g }}
          >
            {row.widths.map((w, k) => {
              const index = row.start + k;
              const image = images[index]!;
              const selected = selecting && selectionIds(image).every(id => selection.ids.has(id));
              return (
                <Tile
                  key={image.id}
                  image={image}
                  width={w}
                  height={row.height}
                  selected={selected}
                  flash={flash.has(image.id)}
                  selectable={!!selectionScope}
                  selecting={selecting}
                  onClick={(e) => handleClick(e, image, index)}
                  onToggle={() => toggleImageSelection(image)}
                  // 触屏长按：进入多选并选中这一张（A1）；已经选中的不动
                  onLongPress={selectionScope ? () => void (!selected && toggleImageSelection(image)) : undefined}
                  onFavorite={
                    canFavorite
                      ? () => favorite.mutate({ ids: selectionIds(image), value: !(image.collectionGroup?.allFavorite ?? image.favorite) })
                      : undefined
                  }
                  overlay={renderOverlay?.(image)}
                  badges={renderBadges?.(image)}
                  rated={rated?.(image)}
                  blurContext={blurContext}
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
  // 收拢的组图在看图器里展开当前范围内的成员，勾选也按这些成员算
  const ids = useMemo(() => images.flatMap(selectionIds), [images]);
  const gridId = useId();
  const syncLightbox = useLightbox((s) => s.syncIds);
  useEffect(() => syncLightbox(ids, gridId), [ids, gridId, syncLightbox]);

  const selection = useSelection();
  useEffect(() => {
    if (selectionScope) selection.setScope(selectionScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionScope]);
  const selecting = isSelecting(selection, selectionScope);
  const showLightbox = useLightbox((s) => s.show);

  const handleClick = (e: React.MouseEvent, image: ImageItem, index: number) => {
    if (selectionScope) {
      if (e.shiftKey) {
        // 区间选到的格子里有组图：补齐整组
        selection.selectRange(ids, image.id);
        const selected = useSelection.getState().ids;
        const next = new Set(selected);
        for (const i of images) if (selected.has(i.id)) selectionIds(i).forEach((id) => next.add(id));
        selection.setMany([...next]);
        return;
      }
      if (e.ctrlKey || e.metaKey || selecting) return toggleImageSelection(image);
    }
    // 组图格从封面打开看图器；去组图页点右上角的张数
    if (onOpen) onOpen(image, index);
    else {
      // 从格子里「拿起」（SEL-12）
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showLightbox(ids, ids.indexOf(image.id), gridId, { left: r.left, top: r.top, width: r.width, height: r.height, thumb: gridThumbWidth(r.width) });
    }
  };
  return { selection, selecting, handleClick, gridId, ids };
}

/**
 * 页头的「选择」（A1）：触屏上没有悬停出现的勾选圈，给一个看得见的入口；点了进入多选，之后点按图片是勾选。
 * 只在触屏上显示（外层 hidden touch:contents），电脑上照旧悬停勾选圈、Ctrl+点击。
 */
export function SelectButton({ scope }: { scope: string }) {
  const on = useSelection((s) => isSelecting(s, scope));
  return (
    <span className="hidden touch:contents">
      <Button
        variant={on ? 'primary' : 'outline'}
        size="md"
        icon={<CheckCheck />}
        className="rounded-full"
        onClick={() => (on ? useSelection.getState().clear() : useSelection.getState().start(scope))}
      >
        {on ? '完成' : '选择'}
      </Button>
    </span>
  );
}

/** 左上角的勾选圈（ImageGrid、CardGrid 共用） */
export function SelectCircle({ selected, selecting, onToggle, className }: { selected: boolean; selecting: boolean; onToggle: () => void; className?: string }) {
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
          : 'bg-black/30 text-transparent opacity-0 ring-2 ring-white/90 group-hover/tile:opacity-100 hover:bg-black/40 hover:text-white/80 focus-visible:opacity-100',
        selecting && !selected && 'opacity-100',
        className,
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
  badges,
  rated,
  blurContext,
  onFavorite,
  flash,
  onLongPress,
}: {
  image: ImageItem;
  width: number;
  height: number;
  selected: boolean;
  /** 刚撤销回来：描一道朱框，1.6 秒后淡掉 */
  flash?: boolean;
  selectable: boolean;
  selecting: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  overlay?: ReactNode;
  badges?: ReactNode;
  rated?: boolean;
  blurContext?: BlurContext;
  onFavorite?: () => void;
  /** 触屏长按（lib/useLongPress.ts） */
  onLongPress?: () => void;
}) {
  const thumbWidth = gridThumbWidth(width);
  const longPress = useLongPress(onLongPress);
  const starred = image.collectionGroup?.allFavorite ?? image.favorite;
  const names = !selecting && width >= 120 && height >= 120;
  return (
    <div
      className={cn(
        'group/tile group/reveal relative shrink-0 overflow-hidden rounded-[var(--radius-plate-sm)] transition-[scale,box-shadow,translate,outline-color] duration-[280ms] ease-[var(--ease-out-soft)] hover:z-10',
        selected ? 'motion-safe:scale-[.955]' : 'hover:-translate-y-0.5 hover:shadow-lift',
        'outline-offset-2 touch:select-none touch:[-webkit-touch-callout:none]',
        flash ? 'outline-[3px] outline-shu' : 'outline-[3px] outline-transparent',
      )}
      style={{ width, height }}
      data-image-id={image.id}
      {...longPress}
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
          rated={rated}
          blurContext={blurContext}
          imgClassName="group-hover/tile:scale-[1.03]"
        />
      </button>

      <GroupBadge image={image} rated={rated} blurContext={blurContext} />
      {/* 悬停：底部渐变 + 这是谁（BR-5）；多选时和窄格子不显示 */}
      {names && (
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
                : // 要找角色还没找到的才写「未识别」：读服务端给的所在队列，不自己按类型推（附录 #27）
                  image.queue === 'art' || image.queue === 'shelved' || image.queue === 'book'
                  ? '未识别'
                  : ''}
          </span>
        </div>
      )}
      {!selecting && !onFavorite && starred && (
        <span
          aria-label="已收藏"
          className={cn(
            'absolute right-1.5 bottom-1.5 z-10 flex size-7 items-center justify-center text-white',
            '[&_svg]:size-4 [&_svg]:drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]',
          )}
        >
          <Heart className="fill-white" />
        </span>
      )}
      {!selecting && onFavorite && (
        <button
          type="button"
          aria-label={image.collectionGroup ? `${starred ? '取消收藏' : '收藏'}这 ${image.collectionGroup.count} 张` : starred ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
          className={cn(
            'absolute right-1.5 bottom-1.5 z-10 flex size-7 items-center justify-center rounded-full text-white transition-[opacity,scale] duration-200 active:scale-90 [&_svg]:size-4 [&_svg]:drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]',
            starred ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
          )}
        >
          <Heart className={cn(starred && 'fill-white')} />
        </button>
      )}
      {overlay}
      {/* 左下角：类型印、页码、动图标记（D5）；悬停显示角色名时让位 */}
      <TileMarks animated={image.animated} fadeOnHover={names}>
        {badges}
      </TileMarks>

      <MountFrame selected={selected} />
      {selectable && <SelectCircle selected={selected} selecting={selecting} onToggle={onToggle} />}
    </div>
  );
}

/** 网格加载中的骨架 */
export function ImageGridSkeleton({ rows = 3, rowHeight = 240 }: { rows?: number; rowHeight?: number }) {
  const widths = [[1.4, 0.7, 1, 1.5, 0.75], [0.7, 1.8, 0.75, 1], [1, 0.7, 1.3, 0.75, 1.1]];
  const h = gridRowHeight(useViewport(), rowHeight);
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-1.5" style={{ height: h }}>
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
