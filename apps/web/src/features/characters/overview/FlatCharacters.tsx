import type { CharacterSort } from '@emaki/shared';
import { Plus, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, EmptyState, ErrorState, Spinner } from '@/components/ui';
import { formatCount } from '@/lib/format';
import type { CharactersView } from '@/lib/stores';
import { CharacterRows, ListHeader, ListSkeleton } from './CharacterList';
import { useCharactersParams, useFlatCharacters, type WorkScope } from './params';
import { EndMark, NewCharacterButton, SectionBar, SortMenu } from './SectionBar';
import { ShelfGrid, ShelfSkeleton } from './ShelfGrid';
import { useSentinel } from './useSentinel';
import type { WorkIndex } from './works';

/**
 * 不分组的角色列表：选中作品 / 最近在收 / 搜索 / 只看自建，以及列表视图下的总览。
 * 无限滚动；搜索词变化时保留旧结果并变淡，而不是闪一下骨架。
 */
export function FlatCharacters({
  view,
  work,
  q,
  sort,
  source,
  byId,
  customMatchable,
  onSortChange,
  onClearQuery,
  onClearSource,
  onCreate,
}: {
  view: CharactersView;
  work: WorkScope;
  q: string;
  sort: CharacterSort;
  source?: 'custom';
  byId: WorkIndex;
  customMatchable: number;
  onSortChange: (v: CharacterSort) => void;
  onClearQuery: () => void;
  onClearSource: () => void;
  onCreate: (name?: string) => void;
}) {
  const { other, setOther } = useCharactersParams();
  const res = useFlatCharacters({ work, q, sort, source, other });
  const otherOnly = res.data?.pages[0]?.otherOnlyCount ?? 0;
  const items = useMemo(() => res.data?.pages.flatMap((p) => p.items) ?? [], [res.data]);
  const total = res.data?.pages[0]?.total;

  const canLoadMore = !!res.hasNextPage && !res.isFetchingNextPage && !res.isPlaceholderData;
  const sentinel = useSentinel(() => void res.fetchNextPage(), canLoadMore, items.length);

  // 页面按作用域（作品 / 自建）给这里换 key 重新挂载，新的 observer 没有「上一份数据」，
  // 所以占位数据只可能来自同一作用域里的搜索 / 排序变化——这时让旧结果变淡即可
  const dimmed = res.isPlaceholderData;

  const workObj = work && work !== 'recent' ? byId.get(work) : undefined;
  const count = total === undefined ? null : `${formatCount(total)} 位`;

  // ---------------------------------------------------------------- 标题
  let title: ReactNode = '全部角色';
  let hint = joinHint(count);
  if (q) {
    title = `搜索「${q}」`;
    hint = joinHint(workObj?.name ?? (work === 'recent' ? '最近在收' : null), count);
  } else if (source === 'custom') {
    title = '自建角色';
    hint = joinHint(
      count,
      customMatchable > 0 ? `其中 ${customMatchable} 位能对上 Danbooru 标签，在角色的「编辑」里关联即可` : null,
    );
  } else if (work === 'recent') {
    title = '最近在收的角色';
    hint = joinHint('最近 30 天有新图', count);
  } else if (workObj) {
    hint = joinHint(workObj.name, count);
  }

  const actions = (
    <>
      {q && (
        <Button variant="ghost" size="sm" icon={<X className="size-3.5" />} onClick={onClearQuery}>
          清除搜索
        </Button>
      )}
      {source === 'custom' && (
        <Button variant="ghost" size="sm" icon={<X className="size-3.5" />} onClick={onClearSource}>
          显示全部
        </Button>
      )}
      <SortMenu value={sort} onChange={onSortChange} />
      <NewCharacterButton onClick={() => onCreate(q || undefined)} />
    </>
  );

  // ---------------------------------------------------------------- 内容
  let body: ReactNode;
  if (res.isError) {
    body = <ErrorState error={res.error} onRetry={() => void res.refetch()} />;
  } else if (res.isLoading || !res.data) {
    body = view === 'shelf' ? <ShelfSkeleton count={18} /> : <ListSkeleton rows={12} />;
  } else if (items.length === 0) {
    body = <Empty q={q} work={work} source={source} workName={workObj?.name} onCreate={onCreate} />;
  } else {
    body =
      view === 'shelf' ? (
        <ShelfGrid items={items} byId={byId} showWork={!workObj} dimmed={dimmed} />
      ) : (
        <CharacterRows items={items} byId={byId} dimmed={dimmed} />
      );
  }

  const showListHeader = view === 'list' && items.length > 0 && !res.isError;

  return (
    <section>
      <SectionBar title={title} hint={hint} actions={actions} below={showListHeader ? <ListHeader /> : undefined} />
      {body}
      <div ref={sentinel} aria-hidden />
      {res.isFetchingNextPage && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-fg-subtle">
          <Spinner className="size-3.5" />
          正在加载更多角色
        </div>
      )}
      {!res.hasNextPage && !res.isLoading && (otherOnly > 0 || other) && (
        <div className="pt-8 text-center text-[12.5px] text-fg-muted">
          {other ? (
            <>
              已列出只出现在漫画、截图等里的角色 ·{' '}
              <button type="button" onClick={() => setOther(false)} className="font-medium text-fg hover:underline">
                隐藏
              </button>
            </>
          ) : (
            <>
              另有 {formatCount(otherOnly)} 位角色只出现在漫画、截图等里 ·{' '}
              <button type="button" onClick={() => setOther(true)} className="font-medium text-fg hover:underline">
                显示
              </button>
            </>
          )}
        </div>
      )}
      {!res.hasNextPage && items.length > 24 && <EndMark total={total} />}
    </section>
  );
}

const joinHint = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');

function Empty({
  q,
  work,
  source,
  workName,
  onCreate,
}: {
  q: string;
  work: WorkScope;
  source?: 'custom';
  workName?: string;
  onCreate: (name?: string) => void;
}) {
  const createButton = (label: string, name?: string) => (
    <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => onCreate(name)}>
      {label}
    </Button>
  );

  if (q) {
    return (
      <EmptyState
        glyph="寻"
        title={`没有找到「${q}」`}
        description={
          workName
            ? `「${workName}」里没有叫这个名字的角色。试试日文名、罗马音，或者切回总览再搜。也可以直接把它建成自建角色。`
            : '试试日文名、罗马音或作品名。如果是原创角色、画师 OC，或者 Danbooru 上还没有的角色，可以直接新建一个。'
        }
        action={createButton('新建自建角色', q)}
      />
    );
  }
  if (source === 'custom') {
    return (
      <EmptyState
        glyph="自"
        title="还没有自建角色"
        description="Danbooru 上没有的角色（原创、冷门、画师 OC）可以手动建一个，再把图归过去。"
        action={createButton('新建自建角色')}
      />
    );
  }
  if (work === 'recent') {
    return (
      <EmptyState
        glyph="静"
        title="最近 30 天没有新图"
        description="新收的插画识别出角色后，会按角色出现在这里。"
      />
    );
  }
  if (work) {
    return (
      <EmptyState
        glyph="空"
        title="这部作品还没有角色"
        description="图归到这部作品的角色之后，会出现在这里。"
        action={createButton('新建角色')}
      />
    );
  }
  return (
    <EmptyState
      glyph="人"
      title="还没有角色"
      description="添加图库文件夹并运行识别后，角色会按作品自动整理到这里。"
      action={
        <Link
          to="/settings"
          className="inline-flex h-9 items-center rounded-md bg-ink px-3.5 text-sm font-medium text-fg-inverse transition-colors hover:bg-ink-hover"
        >
          添加图片文件夹
        </Link>
      }
    />
  );
}
