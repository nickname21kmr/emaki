import type { ID, UnrecognizedItem } from '@emaki/shared';
import { Check, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useRef } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, formatPercent } from '@/lib/format';
import type { ClickModifiers, Triage } from '../useTriage';
import { FreshButton } from './FreshButton';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;
/** 一行的高度：48px 缩略图 + 内边距 */
const ROW_H = 66;
const VIRTUAL_FROM = 300;

/**
 * 左侧队列：窄的缩略图竖列表，独立滚动。
 * 当前项是一张浮起的「纸片」+ 左侧朱色书签线（用 layoutId 在行间滑动）；
 * 处理掉的项高度收起、淡出，后面的自然补位。
 */
export function TriageQueue({ triage }: { triage: Triage }) {
  const { items, current, selected, total } = triage;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const currentId = current?.image.id;

  // 超过 300 项时虚拟化（TR-13）：只渲染看得见的几十行；少于 300 项保留收起动画
  const virtual = items.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  // 当前项始终在可视范围内（键盘连按 J 时列表跟着走）
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !currentId) return;
    if (virtual) {
      const i = items.findIndex((it) => it.image.id === currentId);
      if (i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' });
      return;
    }
    const el = scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(currentId)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, virtual]);

  // triage 的回调每次渲染都是新的；用 ref 转一道，行组件的 memo 才有意义（队列可能有几百项）
  const latest = useRef(triage);
  latest.current = triage;
  const onClick = useCallback((id: ID, mods: ClickModifiers) => latest.current.clickItem(id, mods), []);
  const onToggle = useCallback((id: ID) => latest.current.toggleSelect(id), []);

  // 滚到底部加载下一页。刷新期间不翻页（见 useTriage），所以刷新结束后重新挂一次，
  // IntersectionObserver 挂上时会立刻回报一次当前是否可见，停在底部也能接着加载
  const busy = triage.query.isFetching;
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && latest.current.loadMore(), {
      root,
      rootMargin: '0px 0px 320px 0px',
    });
    io.observe(target);
    return () => io.disconnect();
  }, [busy]);

  return (
    <aside className="flex min-h-0 w-[232px] shrink-0 flex-col xl:w-[264px]">
      <div className="flex h-8 items-center justify-between px-2">
        <span className="text-[13px] font-semibold tracking-tight">队列</span>
        <span className="flex items-center gap-2">
          <FreshButton stale={triage.query.isStale} onRefresh={() => void triage.query.refetch()} />
          <span className="text-[11.5px] text-fg-subtle tabular">{formatCount(total)} 张</span>
        </span>
      </div>

      <AnimatePresence initial={false}>
        {triage.selectedItems.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-1 flex h-9 items-center justify-between rounded-full bg-ink pr-1 pl-3.5 text-[12.5px] text-fg-inverse">
              <span className="tabular">
                已选 <span className="font-semibold">{triage.selectedItems.length}</span> 张
              </span>
              <button
                onClick={triage.clearSelection}
                className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] text-fg-inverse/70 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse"
              >
                <X className="size-3.5" />
                清除
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={scrollRef} className="relative -mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 scrollbar-thin">
        {virtual ? (
          <ul className="relative pb-2" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const it = items[v.index]!;
              return (
                <div key={it.image.id} className="absolute inset-x-0" style={{ top: v.start, height: ROW_H }}>
                  <QueueRow
                    item={it}
                    position={v.index + 1}
                    current={it.image.id === currentId}
                    selected={selected.has(it.image.id)}
                    onClick={onClick}
                    onToggle={onToggle}
                  />
                </div>
              );
            })}
          </ul>
        ) : (
          <ul className="pb-2">
            <AnimatePresence initial={false}>
              {items.map((it, i) => (
                <QueueRow
                  key={it.image.id}
                  item={it}
                  position={i + 1}
                  current={it.image.id === currentId}
                  selected={selected.has(it.image.id)}
                  onClick={onClick}
                  onToggle={onToggle}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
        <div ref={sentinelRef} className="flex h-10 items-center justify-center text-fg-subtle">
          {triage.isFetchingNextPage && <Spinner className="size-3.5" />}
          {!triage.hasNextPage && items.length > 12 && <span className="text-[11px]">到底了</span>}
        </div>
      </div>

      <div className="mt-2 border-t border-line px-2 pt-2.5 text-[11px] leading-relaxed text-fg-subtle">
        Ctrl / ⌘ 点击多选 · Shift 连选 · X 选中当前
      </div>
    </aside>
  );
}

const QueueRow = memo(function QueueRow({
  item,
  position,
  current,
  selected,
  onClick,
  onToggle,
}: {
  item: UnrecognizedItem;
  position: number;
  current: boolean;
  selected: boolean;
  onClick: (id: ID, mods: ClickModifiers) => void;
  onToggle: (id: ID) => void;
}) {
  const { image, suggestions, tagged } = item;
  const top = suggestions[0];

  return (
    <motion.li
      data-id={image.id}
      exit={{ height: 0, opacity: 0, transition: { duration: 0.34, ease: EASE } }}
      className="overflow-hidden"
    >
      {/* 左侧留 8px 给朱色书签线，li 的 overflow-hidden（收起动画要用）不会把它裁掉 */}
      <div className="py-[3px] pr-1 pl-2">
        <button
          onClick={(e) => onClick(image.id, e)}
          aria-current={current || undefined}
          aria-label={`${image.fileName}${selected ? '（已选中）' : ''}`}
          className={cn(
            'group relative flex w-full items-center gap-3 rounded-[12px] p-1.5 pr-3 text-left outline-none',
            'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-shu',
            !current && 'hover:bg-hover',
          )}
        >
          {current && (
            <>
              <motion.span
                layoutId="triage-current"
                transition={{ type: 'spring', stiffness: 560, damping: 44 }}
                className="absolute inset-0 rounded-[12px] bg-raised shadow-card ring-1 ring-line"
              />
              <motion.span
                layoutId="triage-current-mark"
                transition={{ type: 'spring', stiffness: 560, damping: 44 }}
                className="absolute top-3 bottom-3 -left-[7px] w-[3px] rounded-full bg-shu"
              />
            </>
          )}

          <span
            className={cn(
              'relative size-12 shrink-0 rounded-[10px] transition-shadow duration-200',
              selected && 'shadow-[0_0_0_2px_var(--c-sheet),0_0_0_4px_var(--c-shu)]',
            )}
          >
            <Thumb image={image} width={240} className="size-full rounded-[10px]" />
            {/* 左上角的小圆圈：鼠标也能多选 */}
            <span
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                onToggle(image.id);
              }}
              className={cn(
                'absolute -top-1 -left-1 flex size-[18px] items-center justify-center rounded-full transition-[opacity,transform,background-color] duration-150',
                selected
                  ? 'bg-shu text-white opacity-100'
                  : 'bg-black/30 text-transparent opacity-0 ring-1 ring-white/70 backdrop-blur-sm group-hover:opacity-100 hover:scale-110',
              )}
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
          </span>

          <span className="relative min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  'truncate text-[13px] leading-5',
                  top ? 'font-medium text-fg' : 'text-fg-subtle',
                )}
              >
                {top ? top.name : tagged ? '没有建议' : '尚未识别'}
              </span>
              <span className="shrink-0 text-[10.5px] text-fg-subtle tabular">{position}</span>
            </span>
            {top ? (
              <span className="mt-1 flex items-center gap-2">
                <span className="relative h-[3px] w-full max-w-16 overflow-hidden rounded-full bg-line">
                  <span
                    className={cn('absolute inset-y-0 left-0 rounded-full', current ? 'bg-shu' : 'bg-fg-subtle')}
                    style={{ width: `${top.score * 100}%` }}
                  />
                </span>
                <span className="text-[11px] text-fg-muted tabular">{formatPercent(top.score)}</span>
              </span>
            ) : (
              <span className="mt-1 block truncate text-[11px] text-fg-subtle">{image.fileName}</span>
            )}
          </span>
        </button>
      </div>
    </motion.li>
  );
});
