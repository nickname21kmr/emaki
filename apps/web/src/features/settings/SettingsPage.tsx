import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState } from '@/components/ui';
import { formatBytes, formatCount } from '@/lib/format';
import { useSettings, useStats } from '@/lib/queries';
import { AboutSection } from './components/AboutSection';
import { AppearanceSection } from './components/AppearanceSection';
import { DanbooruSection } from './components/DanbooruSection';
import { DedupeSection } from './components/DedupeSection';
import { JobsSection } from './components/JobsSection';
import { LibrarySection } from './components/LibrarySection';
import { SettingsSkeleton } from './components/SettingsSkeleton';
import { SettingsToc } from './components/SettingsToc';
import { TaggerSection } from './components/TaggerSection';
import { useSectionNav } from './hooks';
import { isSectionId, type SectionId } from './sections';

/**
 * 设置：左侧吸顶小目录 + 右侧分组卡片。修改即时保存（滑块松手时才保存）。
 * 支持 /settings#library 这样的深链接，别的页面可以直接跳到某一节。
 */
export function SettingsPage() {
  const settings = useSettings();
  const { data: stats } = useStats();
  const ready = settings.isSuccess;
  const { active, jump } = useSectionNav(ready);
  const navigate = useNavigate();
  const { hash } = useLocation();

  // 首次加载完成后按 hash 定位一次；之后 hash 由点击目录写入，不再反向触发滚动
  const didInitialJump = useRef(false);
  useEffect(() => {
    if (!ready || didInitialJump.current) return;
    didInitialJump.current = true;
    const id = decodeURIComponent(hash.slice(1));
    if (isSectionId(id)) requestAnimationFrame(() => jump(id, 'auto'));
  }, [ready, hash, jump]);

  const onJump = useCallback(
    (id: SectionId) => {
      jump(id);
      void navigate({ hash: id }, { replace: true, preventScrollReset: true });
    },
    [jump, navigate],
  );

  const roots = settings.data?.libraryRoots;
  const subtitle =
    roots && stats
      ? `${roots.length} 个图库文件夹 · ${formatCount(stats.imageCount)} 张 · ${formatBytes(stats.totalBytes)}`
      : '修改会即时保存';

  return (
    <>
      <PageHeader title="设置" subtitle={subtitle} />
      <PageBody className="pt-4">
        {settings.isPending ? (
          <SettingsSkeleton />
        ) : settings.isError ? (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <div className="flex animate-fade-in gap-14">
            <SettingsToc active={active} onJump={onJump} />
            <div className="max-w-[760px] min-w-0 flex-1 space-y-10">
              <LibrarySection roots={settings.data.libraryRoots} />
              <TaggerSection tagger={settings.data.tagger} unrecognizedCount={stats?.unrecognizedCount} />
              <DanbooruSection danbooru={settings.data.danbooru} />
              <DedupeSection dedupe={settings.data.dedupe} groupCount={stats?.duplicateGroupCount} />
              <AppearanceSection ui={settings.data.ui} />
              <JobsSection />
              <AboutSection stats={stats} />
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
