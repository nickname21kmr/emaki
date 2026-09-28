import type { ID } from '@emaki/shared';
import { SectionTitle } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useCollections } from '@/lib/queries';
import { BookCard } from '@/features/collections/components/Shelf';

/**
 * 角色 / 作品详情的「收录于」（T38f）：这个角色（作品）出现在哪些合集里，一行小书卡，点开是扉页。
 * 没有时整章不渲染，后面的章节编号自动前移。
 */
export function CollectionsStrip({ characterId, workId }: { characterId?: ID; workId?: ID }) {
  const { data } = useCollections(characterId ? { characterId } : { workId });
  if (!data || data.length === 0) return null;
  return (
    <section aria-label="收录于">
      <SectionTitle hint={`${formatCount(data.length)} 本 · 点开按页码读`}>收录于</SectionTitle>
      <div className="-mx-8 flex gap-6 overflow-x-auto px-8 pt-1 pb-2 scrollbar-thin">
        {data.map((c, i) => (
          <div key={c.id} className="w-[150px] shrink-0">
            <BookCard
              c={c}
              index={i}
              size="sm"
              meta={
                c.matchPageCount
                  ? `${formatCount(c.matchPageCount)} 页${characterId ? '出现' : '属于这部作品'}`
                  : '手动关联'
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}
