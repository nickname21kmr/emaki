import type { LibraryStats } from '@emaki/shared';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { RollingNumber, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatPercent, formatRelative } from '@/lib/format';
import { useWorks } from '@/lib/queries';
import { splitBytes, sum } from '../utils';
import { WeekBars } from './WeekBars';

// 第一格要放迷你柱状图，给它多一点宽度
const GRID = 'grid grid-cols-[minmax(0,1.55fr)_repeat(3,minmax(0,1fr))] border-y border-line';
const NUMERAL = 'numeral text-[52px] text-fg';

/**
 * 统计条：四个大号斜体数字横排，像杂志刊头，上下两道细线，不用卡片。
 */
export function StatsStrip({ stats }: { stats: LibraryStats }) {
  const works = useWorks({ sort: 'imageCount' });
  const topWork = works.data?.[0];

  const week = sum(stats.addedLast7Days);
  const illus = stats.kindCounts.illustration;
  const annex = stats.imageCount - illus;
  // 已认出 = 插画和漫画里有角色的比例；放下的不算认出（RV-T-4）
  const art = stats.kindCounts.illustration + stats.kindCounts.comic;
  const recognized = art ? Math.max(0, 1 - (stats.unrecognizedCount + stats.shelvedCount) / art) : 0;
  const seen = stats.imageCount ? 1 - stats.pendingTagCount / stats.imageCount : 0;
  const firstHint = week
    ? `本周新收 ${formatCount(week)}`
    : stats.recentImport
      ? `${formatRelative(stats.recentImport.at)}导入`
      : stats.lastAddedAt
        ? `上次新收 ${formatRelative(stats.lastAddedAt)}`
        : undefined;
  const size = splitBytes(stats.totalBytes);
  const avg = stats.imageCount ? formatBytes(stats.totalBytes / stats.imageCount) : null;

  return (
    <section aria-label="图库概况" className={GRID}>
      <StatCell
        index={0}
        to="/gallery"
        label="张插画"
        hint={[firstHint, annex > 0 ? `另有 ${formatCount(annex)} 张在别册` : ''].filter(Boolean).join(' · ') || undefined}
        aside={week > 0 ? <WeekBars days={stats.addedLast7Days} /> : null}
      >
        <RollingNumber id="images" value={illus} size="xl" className={NUMERAL} />
      </StatCell>

      <StatCell
        index={1}
        to="/characters"
        label="位角色"
        hint={
          stats.pendingTagCount > 0
            ? `识别中 · 已看过 ${formatPercent(seen)}`
            : art
              ? `已认出 ${formatPercent(recognized)} 的插画`
              : undefined
        }
      >
        <RollingNumber id="characters" value={stats.characterCount} size="xl" className={NUMERAL} />
      </StatCell>

      <StatCell
        index={2}
        to="/characters"
        label="部作品"
        hint={topWork ? `收得最多的是「${topWork.name}」` : undefined}
      >
        <RollingNumber id="works" value={stats.workCount} size="xl" className={NUMERAL} />
      </StatCell>

      <StatCell index={3} label="总体积" hint={avg ? `平均每张 ${avg}` : undefined}>
        {/* 单位变了（MB → GB）就换一个 key 重新挂载，免得从 900 滚到 1.2 */}
        <RollingNumber
          key={size.unit}
          id={`bytes:${size.unit}`}
          value={size.value}
          digits={size.digits}
          size="xl"
          className={NUMERAL}
        />
        <span className="ml-1.5 text-[15px] font-medium text-fg-muted">{size.unit}</span>
      </StatCell>
    </section>
  );
}

function StatCell({
  index,
  to,
  label,
  hint,
  aside,
  children,
}: {
  index: number;
  to?: string;
  label: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const className = cn(
    'group relative min-w-0 py-6 animate-rise',
    index === 0 ? 'pr-6' : 'border-l border-line px-6',
    index === 3 && 'pr-0',
  );
  const style: CSSProperties = { animationDelay: `${index * 60}ms` };

  const body = (
    <>
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 items-baseline whitespace-nowrap">{children}</div>
        {aside}
      </div>
      <div className="mt-3.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className="shrink-0 font-medium text-fg">{label}</span>
        {hint && <span className="line-clamp-2 min-w-0 text-fg-subtle">{hint}</span>}
        {to && (
          <ArrowRight
            aria-hidden
            className="size-3.5 shrink-0 -translate-x-1 text-fg-muted opacity-0 transition-[opacity,translate] duration-300 ease-[var(--ease-out-soft)] group-hover:translate-x-0 group-hover:opacity-100"
          />
        )}
      </div>
    </>
  );

  return to ? (
    <Link to={to} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/** 与最终布局等高的骨架 */
export function StatsStripSkeleton() {
  return (
    <section aria-hidden className={GRID}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cn('py-6', i === 0 ? 'pr-6' : 'border-l border-line px-6', i === 3 && 'pr-0')}>
          <div className="flex h-[47px] items-end justify-between gap-4">
            <Skeleton className={cn('h-10', i === 0 ? 'w-32' : 'w-16')} />
            {i === 0 && <Skeleton className="h-11 w-[79px]" />}
          </div>
          <Skeleton className="mt-3.5 h-3.5 w-28" />
        </div>
      ))}
    </section>
  );
}
