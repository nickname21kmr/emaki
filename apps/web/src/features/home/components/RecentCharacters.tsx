import type { LibraryStats } from '@emaki/shared';
import { useMemo } from 'react';
import { AvatarTile } from '@/components/media/AvatarTile';
import { CharacterCover } from '@/components/media/CharacterCover';
import { Badge, ErrorState, SectionTitle } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useCharactersInfinite, useTopCharacters, useWorks } from '@/lib/queries';
import { QuietNote, SeeAllLink } from './Bits';

/**
 * 最近在收（HO-7）：最近 30 天有新图的角色，一行圆头像，按 30 天新增张数从多到少，+N 就是这个数。
 * 为空时（例如首次导入，文件时间都很早）换成「收得最多」一排竖卡（HO-6），不留虚线空洞。
 */
export function RecentCharacters({ stats }: { stats: LibraryStats }) {
  const recent = useTopCharacters({ workId: 'recent', limit: 14 });
  const top = useTopCharacters({ limit: 6 });
  const total = useCharactersInfinite({ workId: 'recent', limit: 1 }).data?.pages[0]?.total;
  const works = useWorks();
  const workName = useMemo(() => new Map((works.data ?? []).map((w) => [w.id, w.name])), [works.data]);
  const empty = recent.isSuccess && recent.data.length === 0;

  if (recent.isError) return <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />;

  if (empty) {
    return (
      <section>
        <SectionTitle
          hint={stats.recentImport ? '这次导入里认出最多的角色' : '最近 30 天没有新收，先看看收得最多的'}
          actions={<SeeAllLink to="/characters">全部</SeeAllLink>}
        >
          收得最多
        </SectionTitle>
        {top.data?.length ? (
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
            {top.data.map((c, i) => (
              <div key={c.id} className="animate-rise" style={{ animationDelay: `${180 + i * 50}ms` }}>
                <CharacterCover character={c} workName={c.workIds[0] ? workName.get(c.workIds[0]) : null} showNew={false} className="aspect-[3/4]" />
              </div>
            ))}
          </div>
        ) : (
          <QuietNote className="h-[88px]">认出角色后，这里会出现收得最多的角色</QuietNote>
        )}
      </section>
    );
  }

  return (
    <section>
      <SectionTitle
        hint={total !== undefined ? `${formatCount(total)} 位角色有新图` : '最近 30 天有新图的角色'}
        actions={<SeeAllLink to="/characters?work=recent">全部</SeeAllLink>}
      >
        最近 30 天在收
      </SectionTitle>
      <div className="-mx-2 flex gap-4 overflow-x-auto px-2 pt-3.5 pb-2 fade-x scrollbar-none">
        {recent.isPending
          ? Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="flex w-[116px] shrink-0 flex-col items-center">
                <div className="skeleton size-[92px] rounded-full" />
                <div className="skeleton mt-4 h-3 w-14 rounded" />
              </div>
            ))
          : recent.data!.map((c, i) => (
              <div key={c.id} className="animate-rise" style={{ animationDelay: `${180 + i * 40}ms` }}>
                <AvatarTile
                  character={c}
                  workName={c.workIds[0] ? workName.get(c.workIds[0]) : null}
                  badge={
                    c.recentCount > 0 ? (
                      <Badge tone="ink" dot="var(--c-ok)">
                        +{formatCount(c.recentCount)}
                      </Badge>
                    ) : undefined
                  }
                />
              </div>
            ))}
      </div>
    </section>
  );
}

export function RecentCharactersSkeleton() {
  return (
    <section aria-hidden>
      <SectionTitle hint="最近 30 天有新图的角色">最近 30 天在收</SectionTitle>
      <div className="flex gap-4 overflow-hidden pt-3.5 pb-2">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex w-[116px] shrink-0 flex-col items-center">
            <div className="skeleton size-[92px] rounded-full" />
            <div className="skeleton mt-4 h-3 w-14 rounded" />
          </div>
        ))}
      </div>
    </section>
  );
}
