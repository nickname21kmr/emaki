import type { BulkCollectionAction, CollectionSummary, ID } from '@emaki/shared';
import { Check, UserRoundPlus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BookFace, BookPlate } from '@/components/media/BookPlate';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { displayTitle, shouldCloth, toShelfUnits, type ShelfUnit } from '@/lib/collections';
import { formatCount } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';
import { useCollections, useMutate } from '@/lib/queries';
import { useBlurPrefs } from '@/lib/stores';
import { CharacterPicker } from '@/features/gallery/CharacterPicker';

const unitIds = (u: ShelfUnit): ID[] => (u.type === 'single' ? [u.c.id] : u.items.map((c) => c.id));
const unitKey = (u: ShelfUnit) => (u.type === 'single' ? u.c.id : `s:${u.key}`);
const unitHead = (u: ShelfUnit): CollectionSummary => (u.type === 'single' ? u.c : u.items[0]!);

/**
 * 成册待整理（T38f 第 4 点，放在「插画 · 漫画」的第一段）：本子和画集整本处理，不逐张。
 * 一本只处理一次：关联角色，或标为已整理。画集排前面（像插画），同类按页数降序。
 */
export function PendingCollections() {
  const list = useCollections({ pending: true });
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const units = useMemo(() => {
    const all = toShelfUnits(list.data ?? []);
    const art = (u: ShelfUnit) => (unitHead(u).kind === 'artbook' ? 0 : 1);
    return all.map((u, i) => ({ u, i })).sort((a, b) => art(a.u) - art(b.u) || a.i - b.i).map((x) => x.u);
  }, [list.data]);
  const visible = units.filter((u) => !gone.has(unitKey(u)));

  const bulk = useMutate((v: { key: string; ids: ID[]; action: BulkCollectionAction }) => api.bulkCollections({ ids: v.ids, action: v.action }));
  const act = (u: ShelfUnit, action: BulkCollectionAction) => {
    const key = unitKey(u);
    setGone((s) => new Set(s).add(key));
    bulk.mutateAsync({ key, ids: unitIds(u), action }).catch(() =>
      setGone((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      }),
    );
  };

  if (list.isPending) {
    return (
      <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-x-5 gap-y-8">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="mx-auto aspect-[5/7] w-[112px] rounded-[6px]" />
        ))}
      </div>
    );
  }
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-3 flex items-baseline gap-3">
        <h3 className="text-[14px] font-semibold">成册待整理</h3>
        <span className="numeral text-[15px] text-fg-muted tabular">{formatCount(visible.length)}</span>
        <span className="text-[12px] text-fg-subtle">一本只处理一次：关联角色，或标为已整理</span>
      </div>
      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState glyph="清" title="没有待整理的合集" description="新成册的本子、画集如果认不出角色，会在这里等你整本处理。" />
        </div>
      ) : (
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pt-2 pb-8 scrollbar-thin">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-9">
            <AnimatePresence initial={false}>
              {visible.map((u, i) => (
                <motion.div
                  key={unitKey(u)}
                  layout
                  exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.22 } }}
                  transition={{ duration: 0.35, ease: EASE_OUT }}
                  className="animate-rise"
                  style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
                >
                  <Unit u={u} onReview={() => act(u, { type: 'review' })} onCharacter={(id) => act(u, { type: 'addCharacter', characterId: id })} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}
    </section>
  );
}

function Unit({ u, onReview, onCharacter }: { u: ShelfUnit; onReview: () => void; onCharacter: (id: ID) => void }) {
  const prefs = useBlurPrefs();
  const head = unitHead(u);
  const href =
    u.type === 'series'
      ? `/collections?series=${encodeURIComponent(u.key)}`
      : `/collections/${u.c.id}${u.c.kind === 'artbook' ? '?filter=unrecognized' : ''}`;
  const name = u.type === 'series' ? u.key : displayTitle(u.c);
  const info =
    u.type === 'series'
      ? `全 ${u.items.length} 话`
      : u.c.kind === 'artbook'
        ? `${formatCount(u.c.unrecognizedPageCount)} 页未认出`
        : `${formatCount(u.c.pageCount)} 页 · 还没关联角色`;
  return (
    <div className="flex flex-col items-center text-center">
      <Link to={href} className="group/book block w-full rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-shu">
        {u.type === 'series' ? (
          <div className="relative mx-auto aspect-[5/7] w-[104px] -translate-x-[6%]">
            {u.items.slice(0, 3).map((c, k) => (
              <BookFace
                key={c.id}
                collection={c}
                cloth={shouldCloth(c, prefs)}
                className={cn(k === 0 && 'z-[3]', k === 1 && 'z-[2] translate-x-[9%] -translate-y-[3%] rotate-3', k === 2 && 'z-[1] translate-x-[18%] -translate-y-[6%] rotate-6')}
              />
            ))}
          </div>
        ) : (
          <BookPlate collection={head} size="sm" />
        )}
        <div className="mt-3 w-full truncate px-1 text-[13px] font-semibold" title={name}>
          {name}
        </div>
        <div className="mt-0.5 text-[11.5px] text-fg-muted tabular">{info}</div>
      </Link>
      <div className="mt-2.5 flex gap-1.5">
        <CharacterPicker title="关联角色" onPick={(c) => onCharacter(c.id)}>
          <Button size="sm" variant="secondary" icon={<UserRoundPlus className="size-3.5" />}>
            关联…
          </Button>
        </CharacterPicker>
        <Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} onClick={onReview}>
          已整理
        </Button>
      </div>
    </div>
  );
}
