import type { UnrecognizedSummary } from '@emaki/shared';
import { Segmented } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useTagJob } from '../useTagJob';
import type { UnrecognizedView } from '../useUnrecognizedParams';

/**
 * 「插画 · 漫画」的分段（TR-1 第 7 条）：成册待整理（按本）/ 有建议 / 没认出 / 待识别，放下的有图时才出现。
 * 识别运行中：「有建议」前亮一个绿点，「待识别」的计数换成进度。
 */
export function BucketTabs({
  value,
  summary,
  pendingBooks,
  onChange,
}: {
  value: UnrecognizedView;
  summary?: UnrecognizedSummary;
  pendingBooks: number;
  onChange: (v: UnrecognizedView) => void;
}) {
  const { running, progress } = useTagJob();
  const art = summary?.art;
  const count = (n: number | undefined) => <span className="text-[11px] text-fg-subtle tabular">{n === undefined ? '' : formatCount(n)}</span>;
  const options: { value: UnrecognizedView; label: React.ReactNode }[] = [];
  if (pendingBooks > 0 || value === 'books') options.push({ value: 'books', label: <>成册待整理 {count(pendingBooks)}</> });
  options.push(
    {
      value: 'suggested',
      label: (
        <span className="inline-flex items-center gap-1.5">
          {running && <span className="size-1.5 animate-pulse rounded-full bg-ok" />}
          有建议 {count(art?.suggested)}
        </span>
      ),
    },
    { value: 'unsure', label: <>没认出 {count(art?.unsure)}</> },
    {
      value: 'untagged',
      label: (
        <>
          待识别{' '}
          {running && progress !== null ? (
            <span className="text-[11px] text-fg-subtle tabular">识别中 {Math.round(progress * 100)}%</span>
          ) : (
            count(art?.untagged)
          )}
        </>
      ),
    },
  );
  if ((art?.shelved ?? 0) > 0 || value === 'shelved') options.push({ value: 'shelved', label: <>放下的 {count(art?.shelved)}</> });
  return <Segmented<UnrecognizedView> size="md" value={value} onChange={onChange} options={options} />;
}
