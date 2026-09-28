import type { Character } from '@emaki/shared';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { CharacterCover } from '@/components/media/CharacterCover';
import { ErrorState, SectionTitle, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useTopCharacters } from '@/lib/queries';
import type { WorkScope } from './params';
import { primaryWorkName, type WorkIndex } from './works';
import { EASE_OUT } from '@/lib/motion';

/*
 * 「你最常看的」Bento：
 *
 *   ┌───────────┬─────┬─────┐
 *   │           │  2  │  3  │  204
 *   │     1     ├─────┼─────┤
 *   │           │  4  │  5  │  204
 *   ├─────┬─────┼─────┼─────┤
 *   │  6  │  7  │  8  │  9  │  260
 *   └─────┴─────┴─────┴─────┘
 *
 * 不足 9 位时右侧和底行按实际数量重新铺满，不留空洞。
 * 窄屏（< md）退化成两列自然流。
 */

const EASE = EASE_OUT;

/** 右侧 2×2 区域在不同数量下的摆放（写成字面量，Tailwind 才扫描得到） */
const SIDE_PLACEMENT: Record<number, string[]> = {
  1: ['md:col-start-3 md:col-span-2 md:row-start-1 md:row-span-2'],
  2: ['md:col-start-3 md:col-span-2 md:row-start-1', 'md:col-start-3 md:col-span-2 md:row-start-2'],
  3: ['md:col-start-3 md:col-span-2 md:row-start-1', 'md:col-start-3 md:row-start-2', 'md:col-start-4 md:row-start-2'],
  4: ['md:col-start-3 md:row-start-1', 'md:col-start-4 md:row-start-1', 'md:col-start-3 md:row-start-2', 'md:col-start-4 md:row-start-2'],
};

const BOTTOM_COLS: Record<number, string> = {
  1: 'md:grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
};

const TOP_GRID = 'grid grid-cols-2 auto-rows-[204px] gap-3 md:grid-cols-4 md:grid-rows-[204px_204px]';
const HERO = 'col-span-2 row-span-2 md:col-start-1 md:row-start-1';
const BOTTOM_GRID = 'mt-3 grid grid-cols-2 auto-rows-[260px] gap-3';

export function TopBento({
  workId,
  byId,
  title,
  hint,
  actions,
}: {
  workId: WorkScope;
  byId: WorkIndex;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  const { data, isLoading, isError, error, refetch } = useTopCharacters({ workId: workId ?? undefined, limit: 9 });

  const heading = (
    <SectionTitle hint={hint} actions={actions}>
      {title}
    </SectionTitle>
  );

  if (isError) {
    return (
      <section>
        {heading}
        <ErrorState error={error} onRetry={() => void refetch()} />
      </section>
    );
  }

  if (isLoading || !data) {
    return (
      <section aria-busy>
        {heading}
        <BentoSkeleton />
      </section>
    );
  }

  // 只有一位时 Bento 没有意义（下面的书架里就能看到）
  if (data.length < 2) return null;

  const [hero, ...rest] = data as [Character, ...Character[]];
  const side = rest.slice(0, 4);
  const bottom = rest.slice(4, 8);
  const workName = (c: Character) => primaryWorkName(c, byId);

  return (
    <section>
      {heading}
      <div className={TOP_GRID}>
        <Tile index={0} className={HERO}>
          <CharacterCover character={hero} workName={workName(hero)} size="xl" showNew={false} className="h-full" />
        </Tile>
        {side.map((c, i) => (
          <Tile key={c.id} index={i + 1} className={SIDE_PLACEMENT[side.length]?.[i]}>
            <CharacterCover character={c} workName={workName(c)} showNew={false} className="h-full" />
          </Tile>
        ))}
      </div>
      {bottom.length > 0 && (
        <div className={cn(BOTTOM_GRID, BOTTOM_COLS[bottom.length])}>
          {bottom.map((c, i) => (
            <Tile key={c.id} index={i + 5}>
              <CharacterCover character={c} workName={workName(c)} showNew={false} className="h-full" />
            </Tile>
          ))}
        </div>
      )}
    </section>
  );
}

/** 依次浮现，节奏跟排名一致：先看到第一名 */
function Tile({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: EASE, delay: index * 0.04 }}
      className={cn('min-w-0', className)}
    >
      {children}
    </motion.div>
  );
}

export function BentoSkeleton() {
  return (
    <div aria-hidden>
      <div className={TOP_GRID}>
        <Skeleton className={cn(HERO, 'rounded-[var(--radius-plate)]')} />
        {SIDE_PLACEMENT[4]!.map((placement, i) => (
          <Skeleton key={i} className={cn(placement, 'rounded-[var(--radius-plate)]')} />
        ))}
      </div>
      <div className={cn(BOTTOM_GRID, BOTTOM_COLS[4])}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="rounded-[var(--radius-plate)]" />
        ))}
      </div>
    </div>
  );
}
