import type { ImageItem } from '@emaki/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Heart } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { MountFrame, SelectCircle, useGridBox, useGridInteractions, useLightboxFeed } from './ImageGrid';
import { Thumb } from './Thumb';

/**
 * 别册的按类陈列（T32b，SEL-6）：列宽固定的卡片网格，按「行」虚拟化。
 * - shot：截图，9:16 竖卡，悬停 0.3 秒后像手指往下翻（2.4 秒到底），长截图标「长 N 屏」
 * - page：文字图，像一页页纸（纸色底、内边距、object-contain 顶对齐），图注是文件名
 * - sticker：表情，方形贴纸格，不裁切，没有图注
 * 交互和 ImageGrid 一致：单击看图器、Ctrl/Shift 多选、左上勾选圈。
 */
export type CardVariant = 'shot' | 'page' | 'sticker';

const CFG: Record<CardVariant, { min: number; gap: number; ratio: number; caption: number }> = {
  shot: { min: 148, gap: 12, ratio: 16 / 9, caption: 22 },
  page: { min: 176, gap: 14, ratio: 5 / 4, caption: 24 },
  sticker: { min: 112, gap: 8, ratio: 1, caption: 0 },
};

export function CardGrid({
  images,
  variant,
  selectionScope,
  hasMore,
  loadingMore,
  onLoadMore,
  total,
}: {
  images: ImageItem[];
  variant: CardVariant;
  /** 整个列表的总数（看图器跨分页，BR-B1） */
  total?: number;
  selectionScope?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const { scrollRef, containerRef, width, scrollMargin } = useGridBox();
  const { selection, selecting, handleClick, gridId, ids } = useGridInteractions(images, selectionScope);
  const cfg = CFG[variant];
  const cols = Math.max(1, Math.floor((width + cfg.gap) / (cfg.min + cfg.gap)));
  const cardW = width > 0 ? (width - cfg.gap * (cols - 1)) / cols : cfg.min;
  const cardH = Math.round(cardW * cfg.ratio);
  const rowH = cardH + cfg.caption + cfg.gap;
  const rowCount = Math.ceil(images.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowH, cols, virtualizer]);

  useLightboxFeed(gridId, ids, { total, hasMore, loadingMore, onLoadMore }, (id) => {
    const at = images.findIndex((i) => i.id === id);
    if (at >= 0) virtualizer.scrollToIndex(Math.floor(at / cols), { align: 'center' });
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= rowCount - 3) onLoadMore?.();
  }, [lastIndex, rowCount, hasMore, loadingMore, onLoadMore]);

  const thumbWidth = variant === 'sticker' ? 240 : 480;

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualRows.map((vr) => {
        const start = vr.index * cols;
        const row = images.slice(start, start + cols);
        return (
          <div
            key={vr.key}
            className="absolute left-0 grid w-full"
            style={{ top: vr.start - scrollMargin, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: cfg.gap }}
          >
            {row.map((image, k) => {
              const index = start + k;
              const selected = selecting && selection.ids.has(image.id);
              return (
                <Card
                  key={image.id}
                  image={image}
                  variant={variant}
                  height={cardH}
                  thumbWidth={thumbWidth}
                  selected={selected}
                  selectable={!!selectionScope}
                  selecting={selecting}
                  onClick={(e) => handleClick(e, image, index)}
                  onToggle={() => selection.toggle(image.id)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Card({
  image,
  variant,
  height,
  thumbWidth,
  selected,
  selectable,
  selecting,
  onClick,
  onToggle,
}: {
  image: ImageItem;
  variant: CardVariant;
  height: number;
  thumbWidth: 240 | 480;
  selected: boolean;
  selectable: boolean;
  selecting: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
}) {
  const scroll = useScrollPeek(variant === 'shot');
  const ratio = image.height / Math.max(image.width, 1);
  return (
    <figure className="min-w-0">
      <div
        {...scroll.handlers}
        data-image-id={image.id}
        className={cn(
          'group/tile group/reveal relative overflow-hidden rounded-[var(--radius-plate-sm)] transition-[scale,box-shadow] duration-300 ease-[var(--ease-out-soft)]',
          variant === 'page' ? 'bg-raised p-2 shadow-plate ring-1 ring-line' : 'bg-sunken',
          variant === 'shot' && 'ring-1 ring-line',
          selected ? 'motion-safe:scale-[.955]' : 'hover:shadow-lift',
        )}
        style={{ height }}
      >
        <button type="button" onClick={onClick} className="block size-full cursor-zoom-in" aria-label={image.fileName}>
          <Thumb
            image={variant === 'shot' ? image : { ...image, dominantColor: 'transparent' }}
            width={thumbWidth}
            className={cn('size-full', variant === 'page' && 'rounded-[3px]')}
            blurBadge="corner"
            revealOnHover
            imgStyle={
              variant === 'shot'
                ? scroll.style
                : variant === 'page'
                  ? { objectFit: 'contain', objectPosition: '50% 0%' }
                  : { objectFit: 'contain', padding: 6 }
            }
          />
        </button>
        {variant === 'shot' && ratio >= 2.6 && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-black/50 px-1.5 text-[10.5px] text-white/90 tabular">
            长 {(ratio / 1.78).toFixed(1)} 屏
          </span>
        )}
        {image.favorite && (
          <Heart className="pointer-events-none absolute right-2 bottom-2 size-4 fill-white text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]" />
        )}
        <MountFrame selected={selected} />
        {selectable && <SelectCircle selected={selected} selecting={selecting} onToggle={onToggle} />}
      </div>
      {variant === 'shot' && <figcaption className="mt-1.5 truncate text-[11px] text-fg-subtle tabular">{formatDate(image.modifiedAt)}</figcaption>}
      {variant === 'page' && (
        <figcaption className="mt-1.5 truncate text-[11.5px] text-fg-muted">{image.fileName.replace(/\.[^.]+$/, '')}</figcaption>
      )}
    </figure>
  );
}

/**
 * 截图的「翻看」：只有被悬停的那一张，停 0.3 秒后 object-position 从顶部匀速滑到底部（2.4 秒），
 * 移开立即回到顶部。系统开了减少动效时不翻。
 */
function useScrollPeek(enabled: boolean) {
  const reduce = useReducedMotion();
  const [down, setDown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const on = enabled && !reduce;
  const handlers = useMemo(
    () =>
      on
        ? {
            onMouseEnter: () => {
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setDown(true), 300);
            },
            onMouseLeave: () => {
              window.clearTimeout(timer.current);
              setDown(false);
            },
          }
        : {},
    [on],
  );
  const style = {
    objectPosition: `50% ${down ? 100 : 0}%`,
    // 内联的 transition 要把 Thumb 自己的淡入 / 模糊过渡一起写上
    transition: `object-position ${down ? '2400ms linear' : '300ms ease-out'}, opacity 500ms, filter 500ms, scale 500ms`,
  };
  return { handlers, style };
}
