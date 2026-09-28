import type { UnrecognizedArea, UnrecognizedSummary } from '@emaki/shared';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { SPRING } from '@/lib/motion';

const AREAS: { key: UnrecognizedArea; label: string }[] = [
  { key: 'art', label: '插画 · 漫画' },
  { key: 'annex', label: '照片 · 文字等' },
];

/** 两个大类页签（T34b）：控件用无衬线、墨色下划线（RV-T-13） */
export function AreaTabs({
  value,
  summary,
  onChange,
}: {
  value: UnrecognizedArea;
  summary?: UnrecognizedSummary;
  onChange: (a: UnrecognizedArea) => void;
}) {
  return (
    <nav role="tablist" aria-label="未识别的大类" className="flex items-end gap-7">
      {AREAS.map(({ key, label }) => {
        const active = key === value;
        const n = summary ? (key === 'art' ? summary.art.total : summary.annex.total) : null;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'relative pb-2 text-[14px] font-semibold tracking-tight transition-colors duration-200',
              active ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {label}
            {n !== null && <span className="numeral ml-1.5 text-[15px] tracking-normal text-fg-subtle tabular">{formatCount(n)}</span>}
            {active && <motion.span layoutId="unrec-area-underline" className="absolute inset-x-0 -bottom-px h-[2px] bg-ink" transition={SPRING} />}
          </button>
        );
      })}
    </nav>
  );
}
