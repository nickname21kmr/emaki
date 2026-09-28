import { ANNEX_KINDS, type ContentKind } from '@emaki/shared';
import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Thumb } from '@/components/media/Thumb';
import { RollingNumber, Seal, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { annexTotal, KIND_GLYPH, KIND_HINT, KIND_LABEL } from '@/lib/kinds';
import { qk, useStats } from '@/lib/queries';

/**
 * 首页最后一段「别册」（T32b，SEL-5）：六类各一格，印章 + 名称 + 张数，下面三张最新的小图条。
 * 张数为 0 的格子变淡、不可点。
 */
export function AnnexIndex() {
  const counts = useStats().data?.kindCounts;
  const previews = useQueries({
    queries: ANNEX_KINDS.map((k) => {
      const q = { kind: [k] as ContentKind[], sort: 'addedAt' as const, limit: 3 };
      return { queryKey: qk.images(q), queryFn: () => api.images(q), staleTime: 5 * 60_000 };
    }),
  });
  const total = annexTotal(counts);
  if (!counts || total === 0) return null;
  return (
    <section>
      <SectionTitle hint={`不是插画的图，自动分开放 · ${formatCount(total)} 张`}>别册</SectionTitle>
      <div className="grid grid-cols-6 border-t border-rule max-[1100px]:grid-cols-3 max-[700px]:grid-cols-2">
        {ANNEX_KINDS.map((k, i) => {
          const n = counts[k];
          const items = previews[i]?.data?.items ?? [];
          return (
            <Link
              key={k}
              to={`/annex/${k}`}
              aria-disabled={n === 0 || undefined}
              className={cn(
                'px-[18px] pt-4 pb-[18px] transition-colors hover:bg-hover',
                i > 0 && 'border-l border-line',
                n === 0 && 'pointer-events-none opacity-40',
              )}
            >
              <div className="flex items-center gap-2.5">
                <Seal variant="zhu" size={24} glyph={KIND_GLYPH[k]} />
                <span className="font-serif-cjk text-[15px] font-semibold tracking-[.08em]">{KIND_LABEL[k]}</span>
                <RollingNumber id={`annex:${k}`} value={n} className="ml-auto numeral text-[26px] leading-none tabular" />
              </div>
              <div className="mt-3 flex h-[74px] gap-1">
                {items.map((img) => (
                  <Thumb key={img.id} image={img} width={240} blurBadge="none" className="flex-1 rounded-[3px] saturate-[.85]" />
                ))}
                {Array.from({ length: Math.max(0, 3 - items.length) }, (_, j) => (
                  <span key={j} className="flex-1 rounded-[3px] bg-sunken" />
                ))}
              </div>
              <div className="mt-2.5 truncate text-[11.5px] text-fg-muted">{KIND_HINT[k]}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
