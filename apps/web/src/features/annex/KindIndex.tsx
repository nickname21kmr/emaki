import { ANNEX_KINDS, type ContentKind } from '@emaki/shared';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { AnimatedGlyph } from '@/components/media/KindBadge';
import { RollingNumber, Seal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCompact } from '@/lib/format';
import { ANIMATED_LABEL, KIND_GLYPH, KIND_LABEL } from '@/lib/kinds';
import { SPRING } from '@/lib/motion';
import { useStats } from '@/lib/queries';

/** 目次里选中的一项：一个类型、全部，或者别册里跨类型的「动图」筛选（D5） */
export type KindScope = 'all' | ContentKind | 'animated';

/**
 * 目次（T32b，SEL-5）：图库和别册共用的一行。「全部 · 插画」之后是 kicker「别册」和五类别册，
 * 最后隔一道细线是 kicker「筛选」和「动图」：动图不是类型（D5），不用类型印，用细线圆圈里的播放三角；
 * 点进去是 /annex/animated，各类里会动的图都在那里。
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
    const n = k === 'all' ? stats?.imageCount : k === 'animated' ? stats?.animatedCount : counts?.[k];
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
        {k === 'animated' ? <AnimatedGlyph size={20} /> : k !== 'all' && <Seal variant="zhu" size={20} glyph={KIND_GLYPH[k]} />}
        <span className={cn('font-serif-cjk font-semibold tracking-[.08em]', active ? 'text-fg' : 'text-fg-muted')}>
          {k === 'all' ? '全部' : k === 'animated' ? ANIMATED_LABEL : KIND_LABEL[k]}
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
      <span aria-hidden className="mx-2 my-3.5 w-px shrink-0 bg-line" />
      <span className="kicker mr-1 shrink-0 self-center" title="不是类型：各类里会动的图（按帧数自动认出）">
        筛选
      </span>
      {item('animated')}
    </nav>
  );
  if (!trailing) return nav;
  return (
    <div className="@container/kindbar flex items-stretch border-y border-line">
      {nav}
      {/* 手机竖屏上收藏、排序在筛选面板里（GalleryToolbar 的 sheetTop），这一行整行给目次 */}
      <div className="flex shrink-0 items-center pl-3 compact:hidden">{trailing}</div>
    </div>
  );
}
