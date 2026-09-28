import type { Character } from '@emaki/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { AvatarTile } from './AvatarTile';

/**
 * 一行圆头像，横向滚动（MG-7）：角色总览和首页的「最近 30 天在收」共用。
 * showRecent：头像右下角显示「+recentCount」（ink 胶囊 + ok 小点，M5 原则 3）；回退成「更多常看的」时不显示。
 */
export function RecentStrip({
  characters,
  workNameOf,
  showRecent = true,
}: {
  characters: Character[];
  workNameOf: (c: Character) => string | null;
  showRecent?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, characters.length]);
  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <div className="group/strip relative">
      <div
        ref={ref}
        onScroll={measure}
        className={cn('-mx-2 flex gap-3.5 overflow-x-auto px-2 pt-3.5 pb-2 scrollbar-none', (edges.left || edges.right) && 'fade-x')}
      >
        {characters.map((c) => (
          <AvatarTile
            key={c.id}
            character={c}
            workName={workNameOf(c)}
            badge={
              showRecent && c.recentCount > 0 ? (
                <Badge tone="ink" dot="var(--c-ok)" className="shadow-card ring-2 ring-sheet">
                  +{formatCount(c.recentCount)}
                </Badge>
              ) : undefined
            }
          />
        ))}
      </div>
      {(['left', 'right'] as const).map((side) => (
        <button
          key={side}
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => page(side === 'left' ? -1 : 1)}
          className={cn(
            'absolute top-[60px] flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-raised text-fg-muted shadow-lift ring-1 ring-line',
            'transition-opacity duration-200 hover:text-fg',
            side === 'left' ? '-left-3' : '-right-3',
            edges[side] ? 'opacity-0 group-hover/strip:opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          {side === 'left' ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ))}
    </div>
  );
}
