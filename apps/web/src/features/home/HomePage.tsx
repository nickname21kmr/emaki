import type { LibraryStats } from '@emaki/shared';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/ui';
import { formatCount, formatRelative } from '@/lib/format';
import { useStats } from '@/lib/queries';
import { AnnexIndex } from './components/AnnexIndex';
import { JobBanner } from './components/JobBanner';
import { LatestImages, LatestImagesSkeleton } from './components/LatestImages';
import { Onboarding } from './components/Onboarding';
import { RecentCharacters, RecentCharactersSkeleton } from './components/RecentCharacters';
import { StatsStrip, StatsStripSkeleton } from './components/StatsStrip';
import { TriageCards, TriageCardsSkeleton } from './components/TriageCards';
import { DailyPlate } from './components/DailyPlate';
import { ImportPanel } from './components/ImportPanel';
import { greeting, importPhase, sum, type ImportPhase } from './utils';
import { useRunningJob } from '@/lib/events';

/**
 * 首页：打开应用第一眼看到「最近收了什么、有什么待处理」。
 * 顺序：统计条 → 待处理 → 最近在收 → 最新入库；空库时换成首次使用引导。
 */
export function HomePage() {
  const stats = useStats();
  const s = stats.data;
  const jobs = {
    scan: useRunningJob('scan'),
    thumbnail: useRunningJob('thumbnail'),
    tag: useRunningJob('tag'),
    dedupe: useRunningJob('dedupe'),
  };
  const phase = s ? importPhase(s, jobs) : null;

  let body;
  if (stats.isError && !s) body = <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  else if (!s) body = <HomeSkeleton />;
  else if (s.imageCount === 0) body = <Onboarding />;
  else
    body = (
      <div className="flex flex-col gap-10">
        {phase && <ImportPanel stats={s} phase={phase} />}
        <StatsStrip stats={s} />
        {s.kindCounts.illustration > 0 && <DailyPlate />}
        <TriageCards stats={s} />
        <RecentCharacters stats={s} />
        <LatestImages stats={s} />
        <AnnexIndex />
      </div>
    );

  return (
    <>
      {!phase && <JobBanner />}
      <PageHeader
        title="首页"
        subtitle={s ? <Subtitle stats={s} phase={phase} /> : <span className="skeleton inline-block h-3 w-56 rounded-sm align-middle" />}
      />
      <PageBody className="pt-2">{body}</PageBody>
    </>
  );
}

/** 「晚上好 · 本周新收 312 张 · 上次扫描 2 小时前」 */
function Subtitle({ stats, phase }: { stats: LibraryStats; phase: ImportPhase }) {
  const week = sum(stats.addedLast7Days);
  const summary =
    stats.imageCount === 0
      ? '图库还是空的'
      : phase && stats.recentImport
        ? `刚导入 ${formatCount(stats.recentImport.count)} 张${phase === 'tagging' ? '，正在识别角色' : ''}`
        : week
          ? `本周新收 ${formatCount(week)} 张`
          : stats.recentImport
            ? `${formatRelative(stats.recentImport.at)}导入了 ${formatCount(stats.recentImport.count)} 张`
            : stats.lastAddedAt
              ? `上次新收是 ${formatRelative(stats.lastAddedAt)}`
              : '这周还没有新收';
  return (
    <>
      {greeting()} · {summary}
      {stats.lastScanAt && <span className="text-fg-subtle"> · 上次扫描 {formatRelative(stats.lastScanAt)}</span>}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-10">
      <StatsStripSkeleton />
      <TriageCardsSkeleton />
      <RecentCharactersSkeleton />
      <LatestImagesSkeleton />
    </div>
  );
}
