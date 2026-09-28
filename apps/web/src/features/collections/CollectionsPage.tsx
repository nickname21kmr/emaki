import type { CollectionKind, CollectionSummary } from '@emaki/shared';
import { Check, UserRoundPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, ErrorState, SearchInput, SectionTitle, Segmented, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { COLLECTION_META, unitWord } from '@/lib/collections';
import { formatCount } from '@/lib/format';
import { useCollections, useMutate } from '@/lib/queries';
import { CharacterPicker } from '@/features/gallery/CharacterPicker';
import { useDebounced } from '@/features/gallery/useDebounced';
import { CollectionShelf, unitCount } from './components/Shelf';

/**
 * 合集书架（T38d）：01 本子 · 02 画集；?kind 只看一类，?q 搜书名 / 社团 / 作者，?series 看一个系列。
 * 按文件夹自动成册，不移动文件。
 */
export function CollectionsPage() {
  const [params, setParams] = useSearchParams();
  const series = params.get('series');
  return series ? <SeriesView seriesKey={series} /> : <ShelfView params={params} setParams={setParams} />;
}

function ShelfView({ params, setParams }: { params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1] }) {
  const kindParam = params.get('kind');
  const kind: CollectionKind | null = kindParam === 'doujin' || kindParam === 'artbook' ? kindParam : null;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q.trim(), 200);
  const list = useCollections({ q: debounced || undefined });
  const all = list.data ?? [];
  const by = (k: CollectionKind) => all.filter((c) => c.kind === k);
  const pages = (xs: CollectionSummary[]) => xs.reduce((n, c) => n + c.pageCount, 0);
  const set = (key: string, v: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set(key, v);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  let body;
  if (list.isError) body = <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  else if (list.isPending) body = <ShelfSkeleton />;
  else if (!all.length)
    body = debounced ? (
      <EmptyState glyph="无" title={`没有找到「${debounced}」`} description="可以搜书名、社团、作者、原作或汉化组。" />
    ) : (
      <EmptyState
        glyph="册"
        title="还没有成册的文件夹"
        description="文件名是页码（001.jpg…），或一组同尺寸的扫描页，扫描后会自动成册；也可以在看图器的信息面板里点「成册」。"
      />
    );
  else
    body = (
      <div className="space-y-14">
        {(['doujin', 'artbook'] as const)
          .filter((k) => !kind || kind === k)
          .map((k) => {
            const xs = by(k);
            if (!xs.length) return null;
            const m = COLLECTION_META[k];
            return (
              <section key={k}>
                <SectionTitle hint={`${formatCount(unitCount(xs))} ${m.unit} · ${formatCount(pages(xs))} 页 · ${m.hint}`}>{m.label}</SectionTitle>
                <CollectionShelf list={xs} />
              </section>
            );
          })}
      </div>
    );

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        sticky
        title="合集"
        subtitle={
          list.data ? (
            <span>
              {formatCount(unitCount(by('doujin')))} 本本子 · {formatCount(unitCount(by('artbook')))} 册画集 · 按文件夹自动成册，不移动文件
            </span>
          ) : (
            <Skeleton className="h-3 w-56 rounded-full" />
          )
        }
      >
        <div className="flex items-center gap-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索书名、社团、作者" className="w-[280px]" />
          <Segmented<'all' | CollectionKind>
            size="sm"
            value={kind ?? 'all'}
            onChange={(v) => set('kind', v === 'all' ? null : v)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'doujin', label: '本子' },
              { value: 'artbook', label: '画集' },
            ]}
          />
        </div>
      </PageHeader>
      <PageBody className="flex-1 pt-6">{body}</PageBody>
    </div>
  );
}

/** 一个系列：全部话数；整套标为已整理、整套关联角色 */
function SeriesView({ seriesKey }: { seriesKey: string }) {
  const list = useCollections({ seriesKey });
  const items = useMemo(() => [...(list.data ?? [])].sort((a, b) => (a.volumeNo ?? 1e9) - (b.volumeNo ?? 1e9)), [list.data]);
  const ids = items.map((c) => c.id);
  const bulk = useMutate((action: Parameters<typeof api.bulkCollections>[0]['action']) => api.bulkCollections({ ids, action }));
  const pages = items.reduce((n, c) => n + c.pageCount, 0);
  const word = unitWord(items);
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        sticky
        kicker={
          <>
            <span className="font-semibold text-shu-fg">合集</span>
            <span className="ml-3">系列</span>
          </>
        }
        title={seriesKey}
        subtitle={list.data ? `全 ${items.length} ${word} · ${formatCount(pages)} 页` : undefined}
        actions={
          items.length > 0 && (
            <>
              <Button variant="ghost" size="sm" icon={<Check className="size-3.5" />} onClick={() => bulk.mutate({ type: 'review' })}>
                整套标为已整理
              </Button>
              <CharacterPicker title="整套关联角色" meta={`${items.length} ${word}`} onPick={(c) => bulk.mutate({ type: 'addCharacter', characterId: c.id })}>
                <Button variant="ghost" size="sm" icon={<UserRoundPlus className="size-3.5" />}>
                  整套关联角色…
                </Button>
              </CharacterPicker>
            </>
          )
        }
      />
      <PageBody className="flex-1 pt-6">
        {list.isPending ? (
          <ShelfSkeleton />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <CollectionShelf list={items.map((c) => ({ ...c, seriesKey: null }))} meta={(c) => `第 ${c.volumeNo ?? '?'} ${word} · ${formatCount(c.pageCount)} 页`} />
        )}
      </PageBody>
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i}>
          <Skeleton className="mx-auto aspect-[5/7] w-[62%] max-w-[210px] rounded-[var(--radius-book)]" />
          <Skeleton className="mx-auto mt-4 h-3 w-20" />
          <Skeleton className="mx-auto mt-2 h-4 w-32" />
        </div>
      ))}
    </div>
  );
}
