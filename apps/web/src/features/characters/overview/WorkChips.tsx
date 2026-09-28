import type { ID } from '@emaki/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Chip, ChipAvatar, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useHotkey } from '@/lib/hotkeys';
import { useCharactersInfinite, useStats } from '@/lib/queries';
import { AllWorksPopover } from './AllWorksPopover';
import type { WorkScope } from './params';
import { useWorkIndex, workAvatar } from './works';

/** chip 行里直接露出的作品数；其余的在「全部作品」里找 */
const MAX_CHIPS = 16;

/**
 * 作品 chip 行：总览 / 最近在收 / 按张数排序的作品…… / 全部作品 ⌄
 * 横向滚动，两端按能否继续滚动决定是否渐隐，并在悬停时露出翻页箭头。
 * 快捷键 [ ] 在相邻作用域之间切换。
 */
export function WorkChips({
  selected,
  onSelect,
  hotkeysEnabled,
}: {
  selected: WorkScope;
  onSelect: (v: WorkScope) => void;
  hotkeysEnabled: boolean;
}) {
  const { works, byId, isLoading } = useWorkIndex();
  const { data: stats } = useStats();
  // 「最近在收」的数量 = 最近 30 天有新图的角色数，只取 total，所以 limit 1
  const recent = useCharactersInfinite({ workId: 'recent', limit: 1 });
  const recentCount = recent.data?.pages[0]?.total;

  const visible = useMemo(() => {
    const top = works.slice(0, MAX_CHIPS);
    // 从「全部作品」里选了排在后面的作品：临时补到行尾，保证选中项总是看得见
    if (selected && selected !== 'recent' && !top.some((w) => w.id === selected)) {
      const w = byId.get(selected);
      if (w) top.push(w);
    }
    return top;
  }, [works, byId, selected]);

  // ---------------------------------------------------------------- 快捷键 [ ]
  // 30 天内没有新图时不显示「最近在收」（首次导入的库里文件时间都很早），快捷键也跳过它
  const showRecent = recentCount !== 0 || selected === 'recent';
  const order = useMemo<WorkScope[]>(
    () => [null, ...(showRecent ? (['recent'] as const) : []), ...works.map((w) => w.id)],
    [works, showRecent],
  );
  const step = (delta: number) => {
    const i = order.indexOf(selected);
    const next = order[Math.min(Math.max((i < 0 ? 0 : i) + delta, 0), order.length - 1)];
    if (next !== undefined && next !== selected) onSelect(next);
  };
  useHotkey('[', () => step(-1), { enabled: hotkeysEnabled });
  useHotkey(']', () => step(1), { enabled: hotkeysEnabled });

  // ---------------------------------------------------------------- 横向滚动
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const max = row.scrollWidth - row.clientWidth;
    setEdges((prev) => {
      const next = { left: row.scrollLeft > 2, right: row.scrollLeft < max - 2 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    row.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      row.removeEventListener('scroll', measure);
    };
  }, [measure, isLoading]);

  // chip 数量 / 「最近在收」的数字变了，内容宽度跟着变，重新判断两端能不能滚
  useEffect(measure, [measure, visible.length, recentCount]);

  // 选中项变化时把它滚进可见区（只动横向，不影响页面的纵向滚动）
  useEffect(() => {
    const row = rowRef.current;
    const el = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !el) return;
    const pad = 48;
    if (el.offsetLeft < row.scrollLeft + pad) {
      row.scrollTo({ left: el.offsetLeft - pad, behavior: 'smooth' });
    } else if (el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth - pad) {
      row.scrollTo({ left: el.offsetLeft + el.offsetWidth - row.clientWidth + pad, behavior: 'smooth' });
    }
  }, [selected, visible]);

  const page = (dir: 1 | -1) => {
    const row = rowRef.current;
    row?.scrollBy({ left: dir * row.clientWidth * 0.7, behavior: 'smooth' });
  };

  // 只在能继续滚动的那一侧渐隐
  const mask = `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 40px' : '#000 0'}, ${
    edges.right ? '#000 calc(100% - 56px), transparent 100%' : '#000 100%'
  })`;

  if (isLoading) return <WorkChipsSkeleton />;

  return (
    <div className="flex items-center gap-2">
      <div className="group/row relative min-w-0 flex-1">
        <div
          ref={rowRef}
          role="group"
          aria-label="按作品筛选"
          className="relative -my-1 flex items-center gap-2 overflow-x-auto py-1 pr-6 scrollbar-none"
          style={{ maskImage: mask, WebkitMaskImage: mask }}
        >
          <Chip ink="work-chip-ink" selected={selected === null} onClick={() => onSelect(null)}>
            总览
          </Chip>
          {showRecent && (
            <Chip
              ink="work-chip-ink"
              selected={selected === 'recent'}
              onClick={() => onSelect('recent')}
              count={recentCount}
              leading={<RecentMark />}
            >
              最近在收
            </Chip>
          )}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
          {visible.map((w) => (
            <Chip
              key={w.id}
              ink="work-chip-ink"
              selected={selected === w.id}
              onClick={() => onSelect(w.id)}
              count={w.imageCount}
              leading={<ChipAvatar image={workAvatar(w)} color={w.color} label={w.name} />}
            >
              {w.name}
            </Chip>
          ))}
        </div>

        <PageArrow side="left" show={edges.left} onClick={() => page(-1)} />
        <PageArrow side="right" show={edges.right} onClick={() => page(1)} />
      </div>

      <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
      <AllWorksPopover
        works={works}
        total={stats?.workCount ?? works.length}
        selected={selected === 'recent' ? null : selected}
        onSelect={(id: ID) => onSelect(id)}
      />
    </div>
  );
}

/** 「最近在收」的标记：和「+N」角标同一个绿点，语义一致 */
function RecentMark() {
  return (
    <span className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-ok-soft">
      <span className="size-1.5 rounded-full bg-ok" />
    </span>
  );
}

function PageArrow({ side, show, onClick }: { side: 'left' | 'right'; show: boolean; onClick: () => void }) {
  return (
    <button
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={cn(
        'absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-raised text-fg-muted shadow-lift ring-1 ring-line',
        'transition-[opacity,transform,color] duration-200 hover:text-fg',
        side === 'left' ? 'left-0' : 'right-0',
        show ? 'opacity-0 group-hover/row:opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {side === 'left' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}

const SKELETON_WIDTHS = [56, 108, 132, 116, 104, 96, 124, 88, 112, 100];

export function WorkChipsSkeleton() {
  return (
    <div className="flex items-center gap-2 overflow-hidden" aria-hidden>
      {SKELETON_WIDTHS.map((w, i) => (
        <Skeleton key={i} className="h-8 shrink-0 rounded-full" style={{ width: w }} />
      ))}
    </div>
  );
}
