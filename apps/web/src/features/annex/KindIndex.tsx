import { ANNEX_KINDS, type ContentKind } from '@emaki/shared';
import { motion } from 'motion/react';
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
 */
export function KindIndex({ current, onGallery }: { current: KindScope | null; onGallery?: (v: 'all' | 'illustration') => void }) {
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
          'relative flex h-12 shrink-0 items-center gap-2.5 px-4 text-[13px] outline-none focus-visible:bg-hover',
          empty && 'pointer-events-none opacity-40',
        )}
      >
        {k !== 'all' && <Seal variant="zhu" size={20} glyph={KIND_GLYPH[k]} />}
        <span className={cn('font-serif-cjk font-semibold tracking-[.08em]', active ? 'text-fg' : 'text-fg-muted')}>
          {k === 'all' ? '全部' : KIND_LABEL[k]}
        </span>
        {n !== undefined && (
          <RollingNumber id={`kind-index:${k}`} value={n} format={formatCompact} className="numeral text-[20px] text-fg-muted tabular" />
        )}
        {active && (
          <motion.span layoutId="kind-index-underline" className="absolute inset-x-4 -bottom-px h-[2px] bg-shu" transition={SPRING} />
        )}
      </button>
    );
  };
  return (
    <nav aria-label="类型" className="relative flex items-stretch overflow-x-auto border-y border-line scrollbar-none">
      {item('all')}
      {item('illustration')}
      <span className="kicker mx-2 shrink-0 self-center">别册</span>
      {ANNEX_KINDS.map(item)}
    </nav>
  );
}
