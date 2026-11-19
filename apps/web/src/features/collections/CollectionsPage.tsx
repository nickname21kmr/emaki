import type { CollectionKind, CollectionSummary } from '@emaki/shared';
import { Check, UserRoundPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { Button, EmptyState, ErrorState, SearchInput, SectionTitle, Segmented, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { COLLECTION_META, unitWord } from '@/lib/collections';
import { formatCount } from '@/lib/format';
import { useArtists, useCollections, useMutate } from '@/lib/queries';
import { CharacterPicker } from '@/features/gallery/CharacterPicker';
import { useDebounced } from '@/features/gallery/useDebounced';
import { ArtistShelf } from './components/ArtistShelf';
import { CollectionShelf, unitCount } from './components/Shelf';

/** 「全部」里同一投稿的组图不超过这么多就直接摆出来，多了收成一行（和图库「自动收拢」一个思路：多就收，少就摊开） */
const POSTS_INLINE = 12;

/**
 * 合集书架（T38d）：01 本子 · 02 画集 · 03 组图 · 04 画师；?kind 只看一类，?q 搜书名 / 社团 / 作者 / 画师，?series 看一个系列。
 * 本子、画集按文件夹自动成册；组图是收在一起的散图。都不移动文件。
 * 同一投稿自动收拢的组图可能有几千组：「全部」里超过 POSTS_INLINE 组时先只摆手动收集的，同投稿的收成一行，点开或切到「组图」再看。
 */
export function CollectionsPage() {
  const [params, setParams] = useSearchParams();
  const series = params.get('series');
  return series ? <SeriesView seriesKey={series} /> : <ShelfView params={params} setParams={setParams} />;
}

function ShelfView({ params, setParams }: { params: URLSearchParams; setParams: ReturnType<typeof useSearchParams>[1] }) {
  const kindParam = params.get('kind');
  const kind: CollectionKind | 'artist' | null = kindParam === 'group' || kindParam === 'doujin' || kindParam === 'artbook' || kindParam === 'artist' ? kindParam : null;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q.trim(), 200);
  const list = useCollections({ q: debounced || undefined });
  const all = list.data ?? [];
  // 画师：识别出来的才有（设置 → 识别 里打开「识别画师」）；搜索框也筛画师名
  const artistsQ = useArtists();
  const needle = debounced.toLowerCase();
  const artists = (artistsQ.data ?? []).filter(
    (a) => !needle || [a.name, a.tag, a.twitter ?? '', ...a.tags, ...a.aliases].some((n) => n.toLowerCase().replace(/_/g, ' ').includes(needle.replace(/_/g, ' '))),
  );
  const by = (k: CollectionKind) => all.filter((c) => c.kind === k);
  const [showPosts, setShowPosts] = useState(false);
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
  else if (kind === 'artist')
    body = artists.length ? (
      <section>
        <SectionTitle hint={`${formatCount(artists.length)} 位 · 识别出来的画师，认不出的不在这里`}>画师</SectionTitle>
        <ArtistShelf list={artists} />
      </section>
    ) : (
      <EmptyState
        glyph="画"
        title={debounced ? `没有找到「${debounced}」` : '还没有识别出画师'}
        description="在「设置 → 识别」里打开「识别画师」，识别完的图会按画师归到这里。只认得 Danbooru 上图多的画师，认不出的不会出现。"
      />
    );
  else if (!all.length && !artists.length)
    body = debounced ? (
      <EmptyState glyph="无" title={`没有找到「${debounced}」`} description="可以搜书名、社团、作者、原作或汉化组。" />
    ) : (
      <EmptyState
        glyph="册"
        title="还没有合集"
        description="文件夹里的本子、画集扫描后会自动成册；散图可以在图库里选中后按 G 收进组图，同一投稿的多张也会自动收拢。"
      />
    );
  // 只看一类时这一类是空的（搜索只命中了别的类，或这一类本来就没有）：不能留一片空白
  else if (kind && !by(kind).length)
    body = (
      <EmptyState
        glyph={COLLECTION_META[kind].glyph}
        title={debounced ? `「${COLLECTION_META[kind].label}」里没有找到「${debounced}」` : `还没有${COLLECTION_META[kind].label}`}
        description={debounced ? '别的类别里有搜索结果，切到「全部」能看到。' : '切到「全部」能看到别的类别。'}
        action={
          <Button variant="secondary" size="sm" onClick={() => set('kind', null)}>
            看全部
          </Button>
        }
      />
    );
  else
    body = (
      <div className="space-y-14">
        {(['doujin', 'artbook', 'group'] as const)
          .filter((k) => !kind || kind === k)
          .map((k) => {
            const xs = by(k);
            if (!xs.length) return null;
            const m = COLLECTION_META[k];
            const word = k === 'group' ? '张' : '页';
            // 组图：手动收集的先摆；同一投稿的在「全部」里收成一行
            const posts = k === 'group' ? xs.filter((c) => c.membership === 'post') : [];
            const folded = !kind && !showPosts && posts.length > POSTS_INLINE;
            const shown = (folded ? xs.filter((c) => c.membership !== 'post') : xs).sort(
              (a, b) =>
                k !== 'group' ? 0 : Number(b.membership !== 'post') - Number(a.membership !== 'post') || (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? ''),
            );
            return (
              <section key={k}>
                <SectionTitle hint={`${formatCount(unitCount(xs))} ${m.unit} · ${formatCount(pages(xs))} ${word} · ${m.hint}`}>{m.label}</SectionTitle>
                {shown.length > 0 && <CollectionShelf list={shown} keepOrder={k === 'group'} />}
                {folded && (
                  <button
                    type="button"
                    onClick={() => setShowPosts(true)}
                    className={cn(
                      'flex w-full items-center justify-center gap-2 rounded-lg py-3 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg',
                      shown.length > 0 && 'mt-8',
                    )}
                  >
                    另有 {formatCount(posts.length)} 组是同一投稿自动收拢的 · 显示
                  </button>
                )}
              </section>
            );
          })}
        {!kind && artists.length > 0 && (
          <section>
            <SectionTitle hint={`${formatCount(artists.length)} 位 · 识别出来的画师`}>画师</SectionTitle>
            <ArtistShelf list={artists} />
          </section>
        )}
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
              {formatCount(unitCount(by('doujin')))} 本本子 · {formatCount(unitCount(by('artbook')))} 册画集 · {formatCount(by('group').length)} 组组图
            </span>
          ) : (
            <Skeleton className="h-3 w-56 rounded-full" />
          )
        }
      >
        <div className="flex items-center gap-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索书名、社团、作者、画师" className="w-[280px]" />
          <Segmented<'all' | CollectionKind | 'artist'>
            size="sm"
            value={kind ?? 'all'}
            onChange={(v) => set('kind', v === 'all' ? null : v)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'doujin', label: '本子' },
              { value: 'artbook', label: '画集' },
              { value: 'group', label: '组图' },
              { value: 'artist', label: '画师' },
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
          <CollectionShelf
            keepOrder
            list={items.map((c) => ({ ...c, seriesKey: null }))}
            meta={(c) => `第 ${c.volumeNo ?? '?'} ${word} · ${formatCount(c.pageCount)} 页`}
          />
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
