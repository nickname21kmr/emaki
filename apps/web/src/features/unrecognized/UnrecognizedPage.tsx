import { useCanVisit } from '@/pages';
import { Link } from 'react-router';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui';
import { PromoteSuggestionsButton } from '@/components/media/PromoteSuggestionsButton';
import { formatCount } from '@/lib/format';
import { useSettings, useStats, useUnrecognizedSummary } from '@/lib/queries';
import { AreaTabs } from './components/AreaTabs';
import { ArtKindFilter } from './components/ArtKindFilter';
import { BucketTabs } from './components/BucketTabs';
import { PendingCollections } from './components/PendingCollections';
import { RetagButton } from './components/RetagButton';
import { PixivTagsButton } from './components/PixivTagsButton';
import { RunTaggerButton } from './components/RunTaggerButton';
import { SheetLayout } from './components/SheetLayout';
import { TriageBody } from './components/TriageBody';
import { TriageSkeleton } from './components/TriageSkeleton';
import { useTagJob } from './useTagJob';
import { useUnrecognizedParams } from './useUnrecognizedParams';
import { useAllowedActions, type Need } from '@/lib/capabilities';
import { Slot } from '@/blocks/Slot';

/**
 * 页头按钮需要的能力（lib/capabilities.ts）：Pixiv 补角色是后台任务（jobs），重认没认出的是整库按规则改（rules）；
 * 「识别新图」（RunTaggerButton）、「补采纳」（PromoteSuggestionsButton）各自判断
 */
const HEADER_NEEDS = { pixiv: 'jobs', retag: 'rules' } as const satisfies Record<string, Need>;

/**
 * 未识别（T34b）：两个大类页签。
 * - 插画 · 漫画：成册待整理（按本）/ 有建议、待识别（逐张三栏）/ 没认出（按主题的目次 + 印样）/ 放下的
 * - 照片 · 文字等：别册里没有角色的，按类目次 + 印样，方便挑出分错的
 * 页面撑满一屏，各栏自己滚动。
 */
export function UnrecognizedPage() {
  // 整体的汇总（大类页签用）；分段、印样用按插画 / 漫画筛过的 p.summary
  const summary = useUnrecognizedSummary();
  const { data: stats } = useStats();
  // 「合集」停用了（docs/plugins.md 9.4）：没有「成册待整理」这一栏（里面的每一本都通到合集页）
  const books = useCanVisit()('/collections');
  const pendingBooks = books ? (stats?.pendingCollectionCount ?? 0) : 0;
  const p = useUnrecognizedParams(pendingBooks, books);
  const viewKey = `${p.bucket}:${p.artKind ?? 'all'}`;
  const allow = useAllowedActions(HEADER_NEEDS);

  let body: React.ReactNode;
  if (p.area === 'annex') body = <SheetLayout key="annex" mode="annex" p={p} summary={p.summary} />;
  else if (!p.bucket) body = <TriageSkeleton />;
  else if (p.bucket === 'books') body = <PendingCollections />;
  else if (p.bucket === 'suggested' || p.bucket === 'untagged')
    body = <TriageBody key={viewKey} bucket={p.bucket} artKind={p.artKind} summary={p.summary} onBucket={p.setBucket} />;
  else body = <SheetLayout key={viewKey} mode={p.bucket} p={p} summary={p.summary} />;

  return (
    // 手机竖屏、手机横屏（A1）：整页正常往下滚。平板竖屏（medium）和电脑一样是固定高度、各栏自己滚：
    // 队列有几百张，整页滚的话决策面板的操作键会被队列撑到页面最底下（2026-11-19 平板实测）
    <div className="flex h-full min-h-[620px] flex-col compact:h-auto compact:min-h-0 short:h-auto short:min-h-0">
      <PageHeader title="未识别" nav="unrecognized" subtitle={<Subtitle />} actions={
          <div className="flex items-center gap-2 compact:flex-wrap">
            <Slot
              id="page.unrecognized"
              render={{
                'unrecognized.pixivTags': () => p.area === 'art' && allow.pixiv && <PixivTagsButton />,
                'unrecognized.promote': () => p.kind && <PromoteSuggestionsButton kind={p.kind} />,
                'unrecognized.retag': () => allow.retag && <RetagButton />,
                'unrecognized.runTagger': () => (
                  <RunTaggerButton variant="outline" tip="给还没识别过的图认角色：认得出的直接归入，拿不准的进「有建议」。" />
                ),
              }}
            />
          </div>
        } className="shrink-0">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <AreaTabs value={p.area} summary={summary.data} onChange={p.setArea} />
          {p.area === 'art' && p.bucket && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ArtKindFilter value={p.artKind} bucket={p.bucket} summary={p.summary} onChange={p.setArtKind} />
              <BucketTabs value={p.bucket} summary={p.summary} pendingBooks={pendingBooks} onChange={p.setBucket} />
            </div>
          )}
        </div>
      </PageHeader>
      <div className="flex min-h-0 flex-1 gap-6 px-8 pt-4 pb-6 narrow:px-5 compact:px-4">{body}</div>
    </div>
  );
}

/** 「N 张插画和漫画还没有角色」+ 识别进度（TR-1 第 8 条） */
function Subtitle() {
  const annexOn = useCanVisit()('/annex');
  const { data } = useUnrecognizedSummary();
  const { running, progress } = useTagJob();
  // 设置里关了「未识别里也列出漫画页」：这里只有插画
  const what = useSettings().data?.tagger.comicInUnrecognized === false ? '插画' : '插画和漫画';
  if (!data) return <Skeleton className="h-3.5 w-56" />;
  const { art, annex } = data;
  return (
    <>
      {art.total ? `${formatCount(art.total)} 张${what}还没有角色` : `${what}都有角色了`}
      {running
        ? ` · 识别中${progress !== null ? ` ${Math.round(progress * 100)}%` : ''}，新建议会自动加入`
        : art.untagged > 0 && ` · ${formatCount(art.untagged)} 张还没跑过识别`}
      {annex.total > 0 && annexOn && (
        <span className="text-fg-subtle">
          {' · 另有 '}
          {formatCount(annex.total)} 张在
          <Link to="/annex" className="mx-0.5 text-fg-muted hover:text-fg hover:underline">
            别册
          </Link>
        </span>
      )}
    </>
  );
}
