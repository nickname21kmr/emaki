import type { UnrecognizedArtKind, UnrecognizedSummary } from '@emaki/shared';
import { Segmented } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { artKindFilterUseful, type UnrecognizedView } from '../useUnrecognizedParams';

type Value = 'all' | UnrecognizedArtKind;

/**
 * 「插画 · 漫画」里再分：全部 / 插画 / 漫画。计数是当前分段里各有几张；插画、漫画有一类没有图时不出现。
 * 成册待整理按本处理，不分。
 */
export function ArtKindFilter({
  value,
  bucket,
  summary,
  onChange,
}: {
  value?: UnrecognizedArtKind;
  bucket: UnrecognizedView;
  summary?: UnrecognizedSummary;
  onChange: (k: UnrecognizedArtKind | undefined) => void;
}) {
  if (bucket === 'books' || !summary || !artKindFilterUseful(summary)) return null;
  const { kinds } = summary.art;
  const n = (k: UnrecognizedArtKind) => kinds[k][bucket];
  const count = (v: number) => <span className="text-[11px] text-fg-subtle tabular">{formatCount(v)}</span>;
  return (
    <div className="flex items-center gap-3">
      <Segmented<Value>
        size="sm"
        value={value ?? 'all'}
        onChange={(v) => onChange(v === 'all' ? undefined : v)}
        options={[
          { value: 'all', label: <>全部 {count(n('illustration') + n('comic'))}</> },
          { value: 'illustration', label: <>插画 {count(n('illustration'))}</> },
          { value: 'comic', label: <>漫画 {count(n('comic'))}</> },
        ]}
      />
      <span className="h-4 w-px bg-line" aria-hidden />
    </div>
  );
}
