import { ANNEX_KINDS, type ContentKind, type ListImagesQuery } from '@emaki/shared';
import { useQueries } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AnimatedGlyph } from '@/components/media/KindBadge';
import { Thumb } from '@/components/media/Thumb';
import { RollingNumber, Seal, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { ANIMATED_LABEL, KIND_GLYPH, KIND_HINT, KIND_LABEL } from '@/lib/kinds';
import { qk, useSummary } from '@/lib/queries';

/** 一格：别册的一类，或者最后的「动图」（D5：不是类型，跨类型的筛选） */
type Cell = { key: ContentKind | 'animated'; query: ListImagesQuery };

const CELLS: Cell[] = [
  ...ANNEX_KINDS.map((k) => ({ key: k, query: { kind: [k], sort: 'addedAt' as const, limit: 3 } })),
  { key: 'animated', query: { animated: true, sort: 'addedAt', limit: 3 } },
];

/**
 * 首页最后一段「别册」（T32b，SEL-5）：五类各一格，印章 + 名称 + 张数，下面三张最新的小图条；
 * 最后一格是「动图」：不是类型，用细线圆圈里的播放三角代替类型印、标明「筛选」，各类里会动的图都算（D5）。
 * 张数为 0 的格子变淡、不可点。
 */
export function AnnexIndex() {
  const images = useSummary().data?.images;
  const counts = images?.byKind;
  const previews = useQueries({
    queries: CELLS.map(({ query }) => ({ queryKey: qk.images(query), queryFn: () => api.images(query), staleTime: 5 * 60_000 })),
  });
  const total = images?.annex ?? 0;
  if (!images || !counts || total + images.animated === 0) return null;
  return (
    <section>
      <SectionTitle hint={`不是插画的图，自动分开放 · ${formatCount(total)} 张`}>别册</SectionTitle>
      <div className="grid grid-cols-6 border-t border-rule max-[1100px]:grid-cols-3 max-[700px]:grid-cols-2">
        {CELLS.map(({ key }, i) => {
          const n = key === 'animated' ? images.animated : counts[key];
          const items = previews[i]?.data?.items ?? [];
          const { mark, label, hint }: { mark: ReactNode; label: string; hint: string } =
            key === 'animated'
              ? { mark: <AnimatedGlyph size={24} />, label: ANIMATED_LABEL, hint: '各类里会动的图' }
              : { mark: <Seal variant="zhu" size={24} glyph={KIND_GLYPH[key]} />, label: KIND_LABEL[key], hint: KIND_HINT[key] };
          return (
            <Link
              key={key}
              to={`/annex/${key}`}
              aria-disabled={n === 0 || undefined}
              className={cn(
                // 键盘聚焦：四角印框（SEL-15）
                'focus-frame px-[18px] pt-4 pb-[18px] transition-colors hover:bg-hover',
                i > 0 && 'border-l border-line',
                n === 0 && 'pointer-events-none opacity-40',
              )}
            >
              <div className="flex items-center gap-2.5">
                {mark}
                <span className="font-serif-cjk text-[15px] font-semibold tracking-[.08em]">{label}</span>
                {key === 'animated' && <span className="kicker">筛选</span>}
                <RollingNumber id={`annex:${key}`} value={n} className="ml-auto numeral text-[26px] leading-none tabular" />
              </div>
              <div className="mt-3 flex h-[74px] gap-1">
                {items.map((img) => (
                  <Thumb key={img.id} image={img} width={240} blurBadge="none" className="flex-1 rounded-[3px] saturate-[.85]" />
                ))}
                {Array.from({ length: Math.max(0, 3 - items.length) }, (_, j) => (
                  <span key={j} className="flex-1 rounded-[3px] bg-sunken" />
                ))}
              </div>
              <div className="mt-2.5 truncate text-[11.5px] text-fg-muted">{hint}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
