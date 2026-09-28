import type { CollectionSummary } from '@emaki/shared';
import { Seal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { byline, COLLECTION_META, displayTitle, shouldCloth } from '@/lib/collections';
import { useBlurPrefs } from '@/lib/stores';
import { Thumb } from './Thumb';

/**
 * 一本书的造型（T38d）：封面 + 1–4 层书口 + 书脊阴影；悬停时封面绕左边翻开 14°，露出底页。
 * 开着模糊时，敏感封面或没识别过的本子封面换成「布面」：封面主色 + 衬线书名 + 朱印，不会满屏糊图。
 */
const SIZE = { sm: 'w-[112px]', md: 'w-[62%] max-w-[210px]', lg: 'w-[240px]' } as const;

export function BookPlate({ collection: c, size = 'md', className }: { collection: CollectionSummary; size?: keyof typeof SIZE; className?: string }) {
  const prefs = useBlurPrefs();
  const cloth = shouldCloth(c, prefs);
  const layers = Math.min(size === 'sm' ? 2 : 4, Math.max(1, Math.round(c.pageCount / 40)));
  const under = c.covers[1];
  return (
    <div className={cn('relative mx-auto aspect-[5/7] perspective-[900px]', SIZE[size], className)}>
      {Array.from({ length: layers }, (_, j) => layers - j).map((k) => (
        <div
          key={k}
          aria-hidden
          className="absolute inset-0 rounded-[var(--radius-book)] bg-raised ring-1 ring-line"
          style={{ transform: `translate(${k * 2.5}px, ${k * 1.5}px)` }}
        />
      ))}
      <div className="absolute inset-0 overflow-hidden rounded-[var(--radius-book)] bg-raised">
        {/* 底页只在布面之外、而且（没开模糊或者它是识别过的全年龄页）时显示 */}
        {!cloth && under && (!prefs.blurSensitive || (under.rating === 'general' && c.coverTagged)) && (
          <Thumb image={{ id: under.imageId, rating: under.rating, dominantColor: under.color ?? '#d9d4cc' }} width={240} blurBadge="none" className="size-full" />
        )}
      </div>
      <BookFace collection={c} size={size} cloth={cloth} />
    </div>
  );
}

/** 封面层（系列卡的叠放也用它） */
export function BookFace({ collection: c, size = 'md', cloth, className }: { collection: CollectionSummary; size?: keyof typeof SIZE; cloth: boolean; className?: string }) {
  const cover = c.covers[0];
  return (
    <div
      className={cn(
        'absolute inset-0 origin-left overflow-hidden rounded-[var(--radius-book)] bg-sunken shadow-[var(--shadow-plate)] ring-1 ring-line',
        'transition-[translate,transform,box-shadow] duration-500 ease-[var(--ease-fan)]',
        'motion-safe:group-hover/book:-translate-y-1 motion-safe:group-hover/book:-rotate-y-14 group-hover/book:shadow-[var(--shadow-fan-hover)] motion-safe:group-focus-visible/book:-rotate-y-14',
        className,
      )}
    >
      {cloth || !cover ? (
        <ClothCover collection={c} small={size === 'sm'} />
      ) : (
        <Thumb
          image={{ id: cover.imageId, rating: cover.rating, dominantColor: cover.color ?? '#d9d4cc' }}
          width={size === 'lg' ? 960 : 480}
          blurBadge="none"
          className="size-full"
        />
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/.22),rgb(0_0_0/.06)_4%,rgb(255_255_255/.08)_6%,transparent_12%)]"
      />
    </div>
  );
}

function ClothCover({ collection: c, small }: { collection: CollectionSummary; small: boolean }) {
  const cover = c.covers[0];
  return (
    <div
      className="flex size-full flex-col justify-between px-[12%] pt-[14%] pb-[10%]"
      style={{ background: `color-mix(in oklab, ${cover?.color ?? '#6b5a4e'} 55%, #2a2420)` }}
    >
      <div>
        <div className="truncate text-[10.5px] tracking-[.14em] text-white/70">{byline(c) || COLLECTION_META[c.kind].label}</div>
        <div aria-hidden className="my-2.5 h-[3px] border-y border-white/40" />
        <div
          className={cn(
            'font-serif-cjk font-bold tracking-[.06em] text-white/90',
            small ? 'line-clamp-2 text-[12px] leading-[1.35]' : 'line-clamp-4 text-[15px] leading-[1.35]',
          )}
        >
          {displayTitle(c)}
        </div>
      </div>
      <Seal variant="bai" glyph={COLLECTION_META[c.kind].glyph} className="self-end" />
    </div>
  );
}
