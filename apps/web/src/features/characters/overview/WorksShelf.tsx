import type { ID } from '@emaki/shared';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Button, Chip, ChipAvatar, EmptyState, ErrorState, SectionTitle } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useStats } from '@/lib/queries';
import { EndMark, NewCharacterButton } from './SectionBar';
import { useSentinel } from './useSentinel';
import { WorkFanCard, WorkFanSkeleton } from './WorkFanCard';
import { useWorkIndex, workAvatar } from './works';

/** 至少这么多张才画成扇形卡；长尾（一两张的作品）收成下面的 chip 云，免得满屏空封套 */
const FAN_MIN_IMAGES = 3;
const BATCH = 24;
// 1280 以上一律一排 4 个（全屏也不回到 5 个）、1024 宽 3 个、<1024 两列；24 能被 3、4 整除，分批时最后一行不半空
const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-3 lg:gap-x-6 xl:grid-cols-4 xl:gap-x-6 xl:gap-y-7';

/**
 * 总览的「作品」小节（OV-3）：作品扇形卡网格，分批渲染；长尾作品收成 chip；
 * 末尾引导去「按角色浏览全部」（列表视图）。
 */
export function WorksShelf({ onPick, onCreate, onShowAll }: { onPick: (id: ID) => void; onCreate: () => void; onShowAll: () => void }) {
  const { works: all, isLoading, isError, error, refetch } = useWorkIndex();
  const { data: stats } = useStats();
  const works = all.filter((w) => w.imageCount > 0);
  const fans = works.filter((w) => w.imageCount >= FAN_MIN_IMAGES);
  const rest = works.filter((w) => w.imageCount < FAN_MIN_IMAGES);
  const [shown, setShown] = useState(BATCH);
  const sentinel = useSentinel(() => setShown((n) => n + BATCH), shown < fans.length, shown);

  const title = (
    <SectionTitle
      className="mb-5"
      hint={works.length ? `${formatCount(works.length)} 部 · 按张数` : undefined}
      actions={<NewCharacterButton onClick={onCreate} />}
    >
      作品
    </SectionTitle>
  );

  if (isError) {
    return (
      <section>
        {title}
        <ErrorState error={error} onRetry={() => void refetch()} />
      </section>
    );
  }
  if (isLoading) {
    return (
      <section aria-busy>
        {title}
        <div className={GRID}>
          {Array.from({ length: 8 }, (_, i) => (
            <WorkFanSkeleton key={i} />
          ))}
        </div>
      </section>
    );
  }
  if (!works.length) {
    return (
      <section>
        {title}
        <EmptyState glyph="人" title="还没有角色" description="识别完成后，角色会按作品出现在这里。" className="py-16" />
      </section>
    );
  }

  return (
    <section>
      {title}
      <div className={GRID}>
        {fans.slice(0, shown).map((w, i) => (
          <WorkFanCard key={w.id} work={w} index={i} onPick={onPick} />
        ))}
      </div>
      <div ref={sentinel} aria-hidden />

      {shown >= fans.length && rest.length > 0 && (
        <div className="mt-12">
          <div className="mb-3 text-xs text-fg-subtle">还有 {formatCount(rest.length)} 部作品只有一两张</div>
          <div className="flex flex-wrap gap-2">
            {rest.map((w) => (
              <Chip
                key={w.id}
                size="sm"
                count={w.imageCount}
                leading={<ChipAvatar image={workAvatar(w)} color={w.color} label={w.name} />}
                onClick={() => onPick(w.id)}
              >
                {w.name}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {shown >= fans.length && (
        <>
          <EndMark label={`共 ${formatCount(works.length)} 部作品`} />
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" size="sm" trailing={<ArrowRight className="size-3.5" />} onClick={onShowAll}>
              按角色浏览全部 {formatCount(stats?.characterCount ?? 0)} 位
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
