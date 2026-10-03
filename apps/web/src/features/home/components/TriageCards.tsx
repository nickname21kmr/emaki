import type { LibraryStats } from '@emaki/shared';
import { ArrowRight, Check, CircleHelp, Clock3, Copy, Link2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CoverFan } from '@/components/media/CoverFan';
import { RollingNumber, SectionTitle, Skeleton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useRunningJob } from '@/lib/events';
import { formatBytes, formatCount } from '@/lib/format';
import { useCharactersInfinite, useDuplicates, useSettings, useUnrecognizedInfinite } from '@/lib/queries';
import { AvatarRow, PhotoPair } from './PeekStack';

type CardState = 'active' | 'waiting' | 'cleared' | 'hidden';

interface Card {
  key: string;
  state: CardState;
  to: string;
  icon: ReactNode;
  title: string;
  count: number;
  unit: string;
  description: string;
  /** cleared / waiting 时的一行字 */
  quietText: string;
  /** waiting 时的主文字（「识别中」「还没查找」） */
  waitingLabel?: string;
  waitingIcon?: ReactNode;
  peek?: (wide: boolean) => ReactNode;
}

/**
 * 待处理（HO-3 / 4 / 5 / 8）：未识别 / 重复 / 自建角色。
 * 每张卡有四种状态：有事（active）、在等（waiting：识别或查重还没跑完）、已清空、隐藏（一个自建角色都没有）。
 * 有事的卡变宽，在等和已清空的收成紧凑条；三张都没事时整块只剩一行。
 */
export function TriageCards({ stats }: { stats: LibraryStats }) {
  const unrecognized = useUnrecognizedInfinite({ area: 'art', bucket: 'unsure' }, 12);
  const duplicates = useDuplicates(false);
  const custom = useCharactersInfinite({ source: 'custom', sort: 'imageCount' });
  const settings = useSettings();
  const dedupeJob = useRunningJob('dedupe');
  const tagJob = useRunningJob('tag');

  const queued = stats.untaggedCount;
  const review = Math.max(0, stats.unrecognizedCount - queued);
  const books = stats.pendingCollectionCount;
  const unrecognizedImages = useMemo(() => {
    const items = unrecognized.data?.pages[0]?.items ?? [];
    const tagged = items.filter((it) => it.tagged);
    return (tagged.length ? tagged : items).slice(0, 5).map((it) => it.image);
  }, [unrecognized.data]);
  const firstGroup = duplicates.data?.[0];
  const reclaimable = useMemo(
    () =>
      (duplicates.data ?? []).reduce(
        (total, g) => total + g.images.reduce((s, img) => (g.suggestedKeepIds.includes(img.id) ? s : s + img.bytes), 0),
        0,
      ),
    [duplicates.data],
  );

  const lastRun = settings.data?.dedupe.lastRunAt ?? null;
  const dedupeWaiting =
    !!dedupeJob || (!!settings.data && (lastRun === null || (!!stats.recentImport && lastRun < stats.recentImport.at)));
  const customTotal = custom.data?.pages[0]?.total;

  const cards: Card[] = [
    {
      key: 'unrecognized',
      state: review > 0 || books > 0 ? 'active' : queued > 0 ? 'waiting' : 'cleared',
      to: '/unrecognized',
      icon: <CircleHelp />,
      title: '未识别',
      count: review,
      unit: '张',
      description: [
        queued > 0 ? `模型没把握的插画 · 还有 ${formatCount(queued)} 张排队识别` : '模型没把握的插画，等你确认是谁',
        books > 0 ? `另有 ${formatCount(books)} 本待整理` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      quietText: queued > 0 ? `认不出的图会出现在这里 · 还有 ${formatCount(queued)} 张排队` : '每一张都认出了角色',
      waitingLabel: tagJob ? '识别中' : '排队识别',
      waitingIcon: tagJob ? <Spinner className="size-3.5" /> : <Clock3 className="size-3.5" />,
      peek: (wide) =>
        unrecognizedImages.length >= 3 ? (
          <div className={wide ? 'w-[300px]' : 'w-[150px]'}>
            <CoverFan
              count={wide && unrecognizedImages.length >= 5 ? 5 : 3}
              covers={unrecognizedImages.map((i) => ({ imageId: i.id, rating: i.rating, color: i.dominantColor, focus: null }))}
            />
          </div>
        ) : null,
    },
    {
      key: 'duplicates',
      state: stats.duplicateGroupCount > 0 ? 'active' : dedupeWaiting ? 'waiting' : 'cleared',
      to: '/duplicates',
      icon: <Copy />,
      title: '重复',
      count: stats.duplicateGroupCount,
      unit: '组',
      description: reclaimable > 0 ? `处理后可释放 ${formatBytes(reclaimable)}` : '同一张图的多个副本',
      quietText: dedupeWaiting ? (queued > 0 ? '识别完成后会自动查找重复的图' : '稍后会自动开始') : '没有发现重复的图',
      waitingLabel: dedupeJob ? '正在查找' : '还没查找',
      waitingIcon: dedupeJob ? <Spinner className="size-3.5" /> : <Clock3 className="size-3.5" />,
      peek: () => (firstGroup ? <PhotoPair images={firstGroup.images} exact={firstGroup.kind === 'exact'} /> : null),
    },
    {
      key: 'custom',
      state: customTotal === 0 ? 'hidden' : stats.customMatchableCount > 0 ? 'active' : 'cleared',
      to: '/characters?source=custom',
      icon: <Link2 />,
      title: '自建角色',
      count: stats.customMatchableCount,
      unit: '个',
      description: '能对上 Danbooru 标签，可以关联',
      quietText: '自建角色都已对齐',
      peek: () => <AvatarRow characters={custom.data?.pages[0]?.items ?? []} />,
    },
  ];

  const shown = cards.filter((c) => c.state !== 'hidden');
  const active = shown.filter((c) => c.state === 'active');
  const quiet = shown.filter((c) => c.state !== 'active');

  let body: ReactNode;
  if (!active.length) {
    // 都没事：一行
    body = (
      <div className="flex h-[72px] items-center gap-8 rounded-[16px] px-5 ring-1 ring-line ring-inset">
        {quiet.map((c) => (
          <Link key={c.key} to={c.to} className="flex min-w-0 items-center gap-2.5 text-[13px]">
            <IconDot>{c.icon}</IconDot>
            <span className="text-fg-muted">{c.title}</span>
            <StateDot card={c} />
            <span className="truncate text-[12px] text-fg-subtle">{c.state === 'waiting' ? c.waitingLabel : c.quietText}</span>
          </Link>
        ))}
      </div>
    );
  } else if (active.length === 1) {
    body = (
      <div className="grid grid-cols-3 gap-3">
        <ActiveCard card={active[0]!} index={0} wide className="col-span-2" />
        <div className="flex flex-col gap-3">
          {quiet.map((c, i) =>
            quiet.length > 1 ? <CompactCard key={c.key} card={c} /> : <QuietCard key={c.key} card={c} index={i + 1} />,
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <div className={cn('grid gap-3', active.length === 2 && quiet.length === 0 ? 'grid-cols-2' : 'grid-cols-3')}>
        {active.map((c, i) => (
          <ActiveCard key={c.key} card={c} index={i} />
        ))}
        {quiet.map((c, i) => (
          <QuietCard key={c.key} card={c} index={active.length + i} />
        ))}
      </div>
    );
  }

  return (
    <section>
      <SectionTitle hint={active.length ? '处理完这些，库就干净了' : '都处理完了'}>待处理</SectionTitle>
      {body}
    </section>
  );
}

function IconDot({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken [&_svg]:size-[15px]', muted ? 'text-fg-subtle' : 'text-fg-muted')}>
      {children}
    </span>
  );
}

function StateDot({ card }: { card: Card }) {
  return card.state === 'waiting' ? (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-fg-muted">{card.waitingIcon}</span>
  ) : (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
      <Check className="size-3.5" strokeWidth={2.6} />
    </span>
  );
}

const Arrow = () => (
  <ArrowRight
    aria-hidden
    className="size-3.5 -translate-x-1 text-fg-muted opacity-0 transition-[opacity,translate] duration-300 ease-[var(--ease-out-soft)] group-hover:translate-x-0 group-hover:opacity-100"
  />
);

/** 有事的卡：大数字 + 说明，右侧预览小样；宽卡用五张扇形 */
function ActiveCard({ card, index, wide, className }: { card: Card; index: number; wide?: boolean; className?: string }) {
  const peek = card.peek?.(!!wide);
  return (
    <Link
      to={card.to}
      style={{ animationDelay: `${120 + index * 60}ms` }}
      className={cn(
        'group group/fan @container relative flex h-[172px] animate-rise flex-col overflow-hidden rounded-[16px] bg-raised p-5 ring-1 ring-line',
        'transition-[translate,box-shadow] duration-500 ease-[var(--ease-out-soft)] hover:-translate-y-0.5 hover:shadow-lift',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <IconDot>{card.icon}</IconDot>
        <span className="text-[13px] font-medium text-fg">{card.title}</span>
        <Arrow />
      </div>
      <div className={cn('mt-auto min-w-0', !!peek && (wide ? '@min-[560px]:pr-[340px]' : '@min-[300px]:pr-[150px]'))}>
        <div className="flex items-baseline gap-1.5">
          <RollingNumber id={`triage:${card.key}`} value={card.count} size="xl" className="numeral text-[46px] text-fg" />
          <span className="text-[13px] text-fg-muted">{card.unit}</span>
        </div>
        <p className="mt-2 truncate text-[12.5px] text-fg-muted">{card.description}</p>
      </div>
      {peek && (
        <div className={cn('pointer-events-none absolute top-1/2 hidden -translate-y-1/2', wide ? 'right-6 @min-[560px]:block' : 'right-5 @min-[300px]:block')}>
          {peek}
        </div>
      )}
    </Link>
  );
}

/** 在等 / 已清空的卡（和有事的卡并排时） */
function QuietCard({ card, index }: { card: Card; index: number }) {
  return (
    <Link
      to={card.to}
      style={{ animationDelay: `${120 + index * 60}ms` }}
      className="group relative flex h-[172px] flex-1 animate-rise flex-col rounded-[16px] p-5 ring-1 ring-line ring-inset transition-colors hover:bg-hover"
    >
      <div className="flex items-center gap-2">
        <IconDot muted>{card.icon}</IconDot>
        <span className="text-[13px] font-medium text-fg-muted">{card.title}</span>
        <Arrow />
      </div>
      <div className="mt-auto">
        <div className="flex items-center gap-2">
          <StateDot card={card} />
          <span className="text-[15px] font-medium tracking-tight">{card.state === 'waiting' ? card.waitingLabel : '已清空'}</span>
        </div>
        <p className="mt-2 truncate text-[12.5px] text-fg-subtle">{card.quietText}</p>
      </div>
    </Link>
  );
}

/** 两张叠放时的紧凑条 */
function CompactCard({ card }: { card: Card }) {
  return (
    <Link to={card.to} className="flex h-full min-h-[80px] flex-1 items-center gap-3 rounded-[16px] px-5 ring-1 ring-line ring-inset transition-colors hover:bg-hover">
      <IconDot muted>{card.icon}</IconDot>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg-muted">
          {card.title} · {card.state === 'waiting' ? card.waitingLabel : '已清空'}
        </span>
        <span className="block truncate text-[12px] text-fg-subtle">{card.quietText}</span>
      </span>
      <span className="ml-auto">
        <StateDot card={card} />
      </span>
    </Link>
  );
}

export function TriageCardsSkeleton() {
  return (
    <section aria-hidden>
      <SectionTitle>待处理</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-[172px] flex-col rounded-[16px] p-5 ring-1 ring-line">
            <div className="flex items-center gap-2">
              <div className="skeleton size-7 rounded-full" />
              <Skeleton className="h-3.5 w-14" />
            </div>
            <div className="mt-auto">
              <Skeleton className="h-10 w-20" />
              <Skeleton className="mt-2.5 h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
