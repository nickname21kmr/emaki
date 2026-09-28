import { ArrowRight } from 'lucide-react';
import { RecentStrip } from '@/components/media/RecentStrip';
import { SectionTitle, Skeleton } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useTopCharacters } from '@/lib/queries';
import { primaryWorkName, type WorkIndex } from './works';

/**
 * 总览第二段：「最近 30 天在收」圆头像行（参考图）。
 * 30 天内没有新图（例如整库刚导入，文件时间都很早）时不隐藏，换成「更多常看的」：
 * Top 之后的第 10–34 位，不显示 +N（T30 第 1 步）。
 */
export function OverviewRecent({ byId, onSeeAll }: { byId: WorkIndex; onSeeAll: () => void }) {
  const recent = useTopCharacters({ workId: 'recent', limit: 24 });
  const more = useTopCharacters({ limit: 34 });
  const recentList = (recent.data ?? []).filter((c) => c.recentCount > 0);
  const hasRecent = recentList.length > 0;
  const list = hasRecent ? recentList : (more.data ?? []).slice(9);
  const loading = recent.isLoading || (!hasRecent && more.isLoading);

  if (!loading && list.length === 0) return null;

  return (
    <section>
      <SectionTitle
        hint={hasRecent ? `${formatCount(recentList.length)} 位角色有新图` : '按张数'}
        actions={
          hasRecent ? (
            <button
              type="button"
              onClick={onSeeAll}
              className="group/link inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              全部
              <ArrowRight className="size-3.5 transition-transform duration-300 group-hover/link:translate-x-0.5" />
            </button>
          ) : undefined
        }
      >
        {hasRecent ? '最近 30 天在收' : '更多常看的'}
      </SectionTitle>
      {loading ? (
        <div className="flex gap-3.5 pt-3.5" aria-hidden>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex w-[116px] shrink-0 flex-col items-center gap-4">
              <Skeleton className="size-[92px] rounded-full" />
              <Skeleton className="h-3 w-14" />
            </div>
          ))}
        </div>
      ) : (
        <RecentStrip characters={list} workNameOf={(c) => primaryWorkName(c, byId)} showRecent={hasRecent} />
      )}
    </section>
  );
}
