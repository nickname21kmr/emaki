import { ANNEX_KINDS, type ContentKind } from '@emaki/shared';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { RollingNumber, Seal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCompact } from '@/lib/format';
import { KIND_GLYPH, KIND_LABEL } from '@/lib/kinds';
import { SPRING } from '@/lib/motion';
import { useStats } from '@/lib/queries';

export type KindScope = 'all' | ContentKind;

/**
 * 目次（T32b，SEL-5）：图库和别册共用的一行。「全部 · 插画」之后是 kicker「别册」和六类别册。
 * 全部、插画属于图库（onGallery 回调或跳到 /gallery?kind=…），别册各类跳到 /annex/<kind>。
 * trailing：放在这一行右端、不跟着目次横向滚动的东西（图库把收藏、排序、缩放放在这里）。
 */
export function KindIndex({
  current,
  onGallery,
  trailing,
}: {
  current: KindScope | null;
  onGallery?: (v: 'all' | 'illustration') => void;
  trailing?: ReactNode;
}) {
  const navigate = useNavigate();
  const stats = useStats().data;
  const counts = stats?.kindCounts;
  const go = (k: KindScope) => {
    if (k === 'all' || k === 'illustration') {
      if (onGallery) onGallery(k);
      else navigate(`/gallery?kind=${k}`);
    } else navigate(`/annex/${k}`);
  };
  const item = (k: KindScope) => {
    const n = k === 'all' ? stats?.imageCount : counts?.[k];
    const active = current === k;
    const empty = k !== 'all' && k !== 'illustration' && n === 0;
    return (
      <button
        key={k}
        type="button"
        onClick={() => go(k)}
        aria-current={active ? 'page' : undefined}
        aria-disabled={empty || undefined}
        className={cn(
          'relative flex h-12 shrink-0 items-center gap-2.5 px-4 text-[13px] outline-none focus-visible:bg-hover @max-[940px]/kindbar:px-2.5',
          empty && 'pointer-events-none opacity-40',
        )}
      >
        {k !== 'all' && <Seal variant="zhu" size={20} glyph={KIND_GLYPH[k]} />}
        <span className={cn('font-serif-cjk font-semibold tracking-[.08em]', active ? 'text-fg' : 'text-fg-muted')}>
          {k === 'all' ? '全部' : KIND_LABEL[k]}
        </span>
        {n !== undefined && (
          // 图库里这一行右端还放着收藏、排序、缩放：放不下时先不显示张数，免得后面几类被挤出去
          <RollingNumber
            id={`kind-index:${k}`}
            value={n}
            format={formatCompact}
            className="numeral text-[20px] text-fg-muted tabular @max-[1300px]/kindbar:hidden"
          />
        )}
        {active && (
          <motion.span
            layoutId="kind-index-underline"
            className="absolute inset-x-4 -bottom-px h-[2px] bg-shu @max-[940px]/kindbar:inset-x-2.5"
            transition={SPRING}
          />
        )}
      </button>
    );
  };
  const nav = (
    <nav
      aria-label="类型"
      className={cn('relative flex items-stretch overflow-x-auto scrollbar-none', trailing ? 'min-w-0 flex-1' : 'border-y border-line')}
    >
      {item('all')}
      {item('illustration')}
      <span className="kicker mx-2 shrink-0 self-center">别册</span>
      {ANNEX_KINDS.map(item)}
    </nav>
  );
  if (!trailing) return nav;
  return (
    <div className="@container/kindbar flex items-stretch border-y border-line">
      {nav}
      <div className="flex shrink-0 items-center pl-3">{trailing}</div>
    </div>
  );
}
