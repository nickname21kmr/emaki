import { useCanVisit } from '@/pages';
import type { LibrarySummary } from '@emaki/shared';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { RollingNumber, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatPercent, formatRelative } from '@/lib/format';
import { useWorks } from '@/lib/queries';
import { splitBytes } from '../utils';
import { WeekBars } from './WeekBars';

// 第一格要放迷你柱状图，给它多一点宽度；手机竖屏排成 2×2（A1）
const GRID = 'grid grid-cols-[minmax(0,1.55fr)_repeat(3,minmax(0,1fr))] border-y border-line compact:grid-cols-2';
const NUMERAL = 'numeral text-[52px] text-fg compact:text-[40px]';
/** 2×2 时每格的边线和留白：右边一列有竖线，第二行有横线 */
const CELL_2X2 = ['compact:pr-4', 'compact:pr-0 compact:pl-4', 'compact:border-t compact:border-l-0 compact:pr-4 compact:pl-0', 'compact:border-t compact:pl-4'];

/**
 * 统计条：四个大号斜体数字横排，像杂志刊头，上下两道细线，不用卡片。
 * 数都来自汇总接口（服务端按命名口径算好）：已认出比例、已看过比例、别册张数不在这里算（附录 #28、#29）。
 */
export function StatsStrip({ summary: s }: { summary: LibrarySummary }) {
  // 别册停用了（docs/plugins.md 9.4）就不提它
  const annexOn = useCanVisit()('/annex');
  const works = useWorks({ sort: 'imageCount' });
  const topWork = works.data?.[0];

  const week = s.added.week;
  const firstHint = week
    ? `本周新收 ${formatCount(week)}`
    : s.recentImport
      ? `${formatRelative(s.recentImport.at)}导入`
      : s.added.lastAt
        ? `上次新收 ${formatRelative(s.added.lastAt)}`
        : undefined;
  const size = splitBytes(s.images.bytes);
  const avg = s.images.averageBytes !== null ? formatBytes(s.images.averageBytes) : null;

  return (
    <section aria-label="图库概况" className={GRID}>
      <StatCell
        index={0}
        to="/gallery"
        label="张插画"
        hint={[firstHint, s.images.annex > 0 && annexOn ? `另有 ${formatCount(s.images.annex)} 张在别册` : ''].filter(Boolean).join(' · ') || undefined}
        aside={week > 0 ? <WeekBars days={s.added.last7Days} /> : null}
      >
        <RollingNumber id="images" value={s.images.illustrations} size="xl" className={NUMERAL} />
      </StatCell>

      <StatCell
        index={1}
        to="/characters"
        label="位角色"
        hint={
          s.tagging.pending > 0 && s.tagging.seenRatio !== null
            ? `识别中 · 已看过 ${formatPercent(s.tagging.seenRatio)}`
            : s.recognition.ratio !== null
              ? `已认出 ${formatPercent(s.recognition.ratio)} 的插画`
              : undefined
        }
      >
        <RollingNumber id="characters" value={s.characters} size="xl" className={NUMERAL} />
      </StatCell>

      <StatCell
        index={2}
        to="/characters"
        label="部作品"
        hint={topWork ? `收得最多的是「${topWork.name}」` : undefined}
      >
        <RollingNumber id="works" value={s.works} size="xl" className={NUMERAL} />
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
    'group relative min-w-0 py-6 animate-rise compact:py-4',
    index === 0 ? 'pr-6' : 'border-l border-line px-6',
    index === 3 && 'pr-0',
    CELL_2X2[index],
  );
  const style: CSSProperties = { animationDelay: `${index * 60}ms` };

  const body = (
    <>
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 items-baseline whitespace-nowrap">{children}</div>
        {/* 手机竖屏的格子窄，放不下迷你柱状图 */}
        {aside != null && <div className="contents compact:hidden">{aside}</div>}
      </div>
      {/* 有柱状图时右边让出「近 7 天」那行字的位置，格子变窄（比如开着助手）时说明不会压上去 */}
      <div
        className={cn(
          'mt-3.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] compact:mt-2 compact:text-[12.5px]',
          aside != null && 'pr-12 compact:pr-0',
        )}
      >
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
        <div key={i} className={cn('py-6', i === 0 ? 'pr-6' : 'border-l border-line px-6', i === 3 && 'pr-0', CELL_2X2[i])}>
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
