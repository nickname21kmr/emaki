import type { LibrarySummary } from '@emaki/shared';
import { useEffect, useState } from 'react';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/ui';
import { formatCount, formatRelative } from '@/lib/format';
import { useSettings, useSummary } from '@/lib/queries';
import { AnnexIndex } from './components/AnnexIndex';
import { JobBanner } from './components/JobBanner';
import { LatestImages, LatestImagesSkeleton } from './components/LatestImages';
import { Onboarding } from './components/Onboarding';
import { RecentCharacters, RecentCharactersSkeleton } from './components/RecentCharacters';
import { StatsStrip, StatsStripSkeleton } from './components/StatsStrip';
import { TriageCards, TriageCardsSkeleton } from './components/TriageCards';
import { DailyPlate, DailyPlateSkeleton, usePrefetchDailyPlate } from './components/DailyPlate';
import { ImportPanel } from './components/ImportPanel';
import { lastPlate } from './dailyPlateState';
import { greeting, importPhase, type ImportPhase } from './utils';
import { useIsJobRunning } from '@/lib/events';
import { PageBlocks } from '@/blocks/PageBlocks';

/**
 * 首页：打开应用第一眼看到「最近收了什么、有什么待处理」。
 * 顺序：统计条 → 待处理 → 最近在收 → 最新入库；空库时换成首次使用引导。
 */
export function HomePage() {
  // 首页的数都读汇总接口（P5，附录 #28）
  const summary = useSummary();
  const s = summary.data;
  // 「今日一枚」的抽图不等汇总回来：这里就发，和汇总接口并行（DailyPlate 挂上时用的是同一个查询）
  usePrefetchDailyPlate();
  // 这个库没有可陈列的插画（空库、只有别册）：记下来，下次骨架里不给「今日一枚」占位置
  const noPlate = !!s && s.images.illustrations === 0;
  useEffect(() => {
    if (noPlate) lastPlate.set(false);
  }, [noPlate]);
  // 只看哪几种任务在跑（布尔值）：任务的进度事件每 150ms 一条，订阅 Job 对象的话整页跟着重渲染。进度由导入面板、横幅自己订阅
  const jobs = {
    scan: useIsJobRunning('scan'),
    thumbnail: useIsJobRunning('thumbnail'),
    tag: useIsJobRunning('tag'),
    dedupe: useIsJobRunning('dedupe'),
  };
  const phase = s ? importPhase(s, jobs) : null;

  let body;
  if (summary.isError && !s) body = <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  else if (!s) body = <HomeSkeleton />;
  else if (s.images.total === 0) body = <Onboarding />;
  else
    body = (
      <div className="flex flex-col gap-10">
        {/* 区块按注册表的顺序（blocks/registry.ts 的 home） */}
        <PageBlocks
          page="home"
          render={{
            'home.import': () => phase && <ImportPanel summary={s} phase={phase} />,
            'home.stats': () => <StatsStrip summary={s} />,
            'home.daily': () => s.images.illustrations > 0 && <DailyPlate />,
            'home.triage': () => <TriageCards summary={s} />,
            'home.recent': () => <RecentCharacters summary={s} />,
            'home.latest': () => <LatestImages summary={s} />,
            'home.annex': () => <AnnexIndex />,
          }}
        />
      </div>
    );

  return (
    <>
      {!phase && <JobBanner />}
      <PageHeader
        title="首页"
        subtitle={s ? <Subtitle summary={s} phase={phase} /> : <span className="skeleton inline-block h-3 w-56 rounded-sm align-middle" />}
      />
      <PageBody className="pt-2">{body}</PageBody>
    </>
  );
}

/** 「晚上好 · 本周新收 312 张 · 上次扫描 2 小时前」 */
function Subtitle({ summary: s, phase }: { summary: LibrarySummary; phase: ImportPhase }) {
  const roots = useSettings().data?.libraryRoots ?? [];
  const week = s.added.week;
  const summary =
    s.images.total === 0
      ? roots.length > 0 && roots.every((r) => !r.enabled)
        ? '图库文件夹都停用了'
        : '图库还是空的'
      : phase && s.recentImport
        ? `刚导入 ${formatCount(s.recentImport.count)} 张${phase === 'tagging' ? '，正在识别角色' : ''}`
        : week
          ? `本周新收 ${formatCount(week)} 张`
          : s.recentImport
            ? `${formatRelative(s.recentImport.at)}导入了 ${formatCount(s.recentImport.count)} 张`
            : s.added.lastAt
              ? `上次新收是 ${formatRelative(s.added.lastAt)}`
              : '这周还没有新收';
  return (
    <>
      {greeting()} · {summary}
      {s.lastScanAt && <span className="text-fg-subtle"> · 上次扫描 {formatRelative(s.lastScanAt)}</span>}
    </>
  );
}

function HomeSkeleton() {
  // 上次有「今日一枚」就在它的位置放同一个占位（DailyPlate 抽到之前也是它）：汇总回来、图抽到时，下面几块都不挪地方
  const [plate] = useState(lastPlate.get);
  return (
    <div className="flex flex-col gap-10">
      <StatsStripSkeleton />
      {plate && <DailyPlateSkeleton />}
      <TriageCardsSkeleton />
      <RecentCharactersSkeleton />
      <LatestImagesSkeleton />
    </div>
  );
}
