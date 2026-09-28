import type { ImageItem, LibraryStats } from '@emaki/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { justify } from '@/components/media/justify';
import { ErrorState, SectionTitle } from '@/components/ui';
import { formatDate, formatRelative } from '@/lib/format';
import { useImagesInfinite } from '@/lib/queries';
import { QuietNote, SeeAllLink } from './Bits';

const ROW_HEIGHT = 180;
const GAP = 6; // 与 ImageGrid 默认间距一致，才能算出同样的行
const TARGET = 24;
const MAX_ROWS = 4;

/**
 * 最新入库：取第一页，只保留能铺满的整行（约 24 张），
 * 避免首页底部出现一行参差不齐的「半行」。
 */
export function LatestImages({ stats }: { stats: LibraryStats }) {
  // 最新入库只取插画（T27 CL 七）
  const query = useImagesInfinite({ sort: 'addedAt', kind: ['illustration'] });
  const all = query.data?.pages[0]?.items;

  // 量出和 ImageGrid 一样的容器宽度，用同一个 justify 算行
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const images = useMemo(() => (all ? fitFullRows(all, width) : []), [all, width]);
  const newest = all?.[0];

  let content;
  if (query.isPending) content = <ImageGridSkeleton rows={3} rowHeight={ROW_HEIGHT} />;
  else if (query.isError) content = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (!images.length) content = <QuietNote className="h-[180px]">还没有入库的插画</QuietNote>;
  else content = <ImageGrid images={images} rowHeight={ROW_HEIGHT} gap={GAP} />;

  return (
    <section>
      <SectionTitle
        hint={latestHint(stats, newest?.addedAt)}
        actions={<SeeAllLink to="/gallery" />}
      >
        最新入库
      </SectionTitle>
      <div ref={boxRef} className="animate-fade-in">
        {content}
      </div>
    </section>
  );
}

/** 从前面开始取整行，凑够 ~TARGET 张或 MAX_ROWS 行就停；图少的时候全给 */
function fitFullRows(items: ImageItem[], width: number): ImageItem[] {
  if (items.length <= TARGET) return items;
  if (width <= 0) return items.slice(0, TARGET);
  const rows = justify(items.slice(0, TARGET * 3), width, ROW_HEIGHT, GAP);
  let end = 0;
  // 最后一行是 justify 没拉伸的残行，不要
  for (let i = 0; i < rows.length - 1 && i < MAX_ROWS; i++) {
    end = rows[i]!.end;
    if (end >= TARGET) break;
  }
  return items.slice(0, end || TARGET);
}

export function LatestImagesSkeleton() {
  return (
    <section aria-hidden>
      <SectionTitle>最新入库</SectionTitle>
      <ImageGridSkeleton rows={3} rowHeight={ROW_HEIGHT} />
    </section>
  );
}

/** 最新入库的提示（HO-12）：首次导入时说实话，早于 30 天的写日期 */
function latestHint(stats: LibraryStats, at: string | undefined): string | undefined {
  if (stats.recentImport && stats.addedLast7Days.every((n) => n === 0)) return '首次导入 · 按文件时间排列';
  if (!at) return undefined;
  if (Date.now() - Date.parse(at) > 30 * 86_400_000) return `最近一张 · ${formatDate(at)}`;
  return `最近一张 · ${formatRelative(at)}`;
}
