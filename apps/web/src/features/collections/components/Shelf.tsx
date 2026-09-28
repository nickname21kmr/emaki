import type { CollectionSummary } from '@emaki/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BookFace, BookPlate } from '@/components/media/BookPlate';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { byline, COLLECTION_META, displayTitle, shouldCloth, toShelfUnits, unitWord } from '@/lib/collections';
import { formatCount } from '@/lib/format';
import { useBlurPrefs } from '@/lib/stores';

/** 书卡（T38d）：书的造型 + 纸上的图注（名字无衬线，D8） */
export function BookCard({
  c,
  index = 0,
  meta,
  size = 'md',
}: {
  c: CollectionSummary;
  index?: number;
  meta?: ReactNode;
  /** sm：「收录于」一行里的小书卡 */
  size?: 'sm' | 'md';
}) {
  const m = COLLECTION_META[c.kind];
  return (
    <Link
      to={`/collections/${c.id}`}
      className="group/book block animate-rise rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-shu focus-visible:ring-offset-4 focus-visible:ring-offset-sheet"
      style={{ animationDelay: `${Math.min(index, 11) * 30}ms` }}
      aria-label={`${m.label}《${displayTitle(c)}》，${c.pageCount} 页`}
    >
      <BookPlate collection={c} size={size} />
      <Caption kicker={byline(c) || m.label} name={displayTitle(c)} title={c.folderName}>
        {meta ?? (
          <>
            {formatCount(c.pageCount)} 页{c.translator ? ` · ${c.translator}` : ''}
          </>
        )}
      </Caption>
    </Link>
  );
}

/** 系列卡：最多三本叠放，点进去是这一系列的书架 */
export function SeriesCard({ seriesKey, items, index = 0 }: { seriesKey: string; items: CollectionSummary[]; index?: number }) {
  const prefs = useBlurPrefs();
  const pages = items.reduce((n, c) => n + c.pageCount, 0);
  const stack = items.slice(0, 3);
  return (
    <Link
      to={`/collections?series=${encodeURIComponent(seriesKey)}`}
      className="group/book block animate-rise rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-shu focus-visible:ring-offset-4 focus-visible:ring-offset-sheet"
      style={{ animationDelay: `${Math.min(index, 11) * 30}ms` }}
      aria-label={`系列《${seriesKey}》，全 ${items.length} ${unitWord(items)}`}
    >
      <div className="relative mx-auto aspect-[5/7] w-[56%] max-w-[190px] -translate-x-[6%]">
        {stack.map((c, i) => (
          <BookFace
            key={c.id}
            collection={c}
            cloth={shouldCloth(c, prefs)}
            className={cn(
              i === 0 && 'z-[3]',
              i === 1 && 'z-[2] translate-x-[9%] -translate-y-[3%] rotate-3',
              i === 2 && 'z-[1] translate-x-[18%] -translate-y-[6%] rotate-6',
            )}
          />
        ))}
      </div>
      <Caption kicker={byline(items[0]!) || '连载'} name={seriesKey}>
        全 {items.length} {unitWord(items)} · {formatCount(pages)} 页
      </Caption>
    </Link>
  );
}

function Caption({ kicker, name, title, children }: { kicker: string; name: string; title?: string; children: ReactNode }) {
  return (
    <div className="mt-4 px-2 text-center">
      <div className="truncate text-[11px] tracking-[.12em] text-fg-subtle">{kicker}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tracking-tight" title={title}>
        {name}
      </div>
      <div className="mt-0.5 truncate text-[12.5px] text-fg-muted tabular">{children}</div>
    </div>
  );
}

const PAGE = 120;

/** 书架（书架页和别册·漫画共用）：1440 宽一行 4 本；单元太多时先渲染 120 个 */
export function CollectionShelf({ list, meta }: { list: CollectionSummary[]; meta?: (c: CollectionSummary) => ReactNode }) {
  const units = toShelfUnits(list);
  const [all, setAll] = useState(false);
  const shown = all ? units : units.slice(0, PAGE);
  return (
    <>
      <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((u, i) =>
          u.type === 'single' ? (
            <BookCard key={u.c.id} c={u.c} index={i} meta={meta?.(u.c)} />
          ) : (
            <SeriesCard key={`s:${u.key}`} seriesKey={u.key} items={u.items} index={i} />
          ),
        )}
      </div>
      {units.length > shown.length && (
        <div className="mt-10 flex justify-center">
          <Button variant="outline" onClick={() => setAll(true)}>
            显示全部 {formatCount(units.length)} 本
          </Button>
        </div>
      )}
    </>
  );
}

/** 按单元计数（系列算一个） */
export const unitCount = (list: CollectionSummary[]) => toShelfUnits(list).length;
