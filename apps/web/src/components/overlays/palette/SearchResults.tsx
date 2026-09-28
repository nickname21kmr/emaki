import type { Character, SearchHit, Work } from '@emaki/shared';
import { Command } from 'cmdk';
import { Search, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useSearch } from '@/lib/queries';
import { matchCommand, type PaletteCommand } from './commands';
import { CommandGroups } from './CommandGroups';
import {
  CharacterAvatar,
  CountMeta,
  Dotted,
  GroupHeading,
  Highlight,
  IconTile,
  PaletteItem,
  PaletteSkeleton,
  TagTile,
  WorkTile,
} from './items';

type CharacterHit = Extract<SearchHit, { type: 'character' }>;
type WorkHit = Extract<SearchHit, { type: 'work' }>;
type TagHit = Extract<SearchHit, { type: 'tag' }>;

/** 角色太多会把作品 / 标签挤到很下面，超出的给一个「去角色页看全部」 */
const MAX_CHARACTERS = 8;

export interface SearchActions {
  openCharacter: (character: Character, workName: string | null) => void;
  openWork: (work: Work) => void;
  openTag: (tag: string) => void;
  go: (to: string) => void;
}

/**
 * 有输入时的结果：角色 / 作品 / 标签来自服务端（useSearch），命令在本地过滤。
 * query 是已经防抖过的搜索词；typing 表示输入还没稳定下来。
 */
export function SearchResults({
  query,
  typing,
  commands,
  actions,
}: {
  query: string;
  typing: boolean;
  commands: PaletteCommand[];
  actions: SearchActions;
}) {
  // 这个组件只在有输入时挂载：清空再输入会重新建 observer，不会闪出上一轮的旧结果
  const search = useSearch(query);
  const hits = search.data ?? [];
  const chars = hits.filter((h): h is CharacterHit => h.type === 'character');
  const works = hits.filter((h): h is WorkHit => h.type === 'work');
  const tags = hits.filter((h): h is TagHit => h.type === 'tag');
  const matchedCommands = commands.filter((c) => matchCommand(c, query));

  const loading = !search.data && !search.isError && (typing || search.isPending);

  const galleryItem = query && (
    <PaletteItem
      value="find:gallery"
      onSelect={() => actions.go(`/gallery?${new URLSearchParams({ q: query, kind: 'all' })}`)}
      leading={<IconTile icon={Search} />}
      title={
        <>
          <span className="text-fg-muted">在图库里搜索</span>「{query}」
        </>
      }
      subtitle="按文件名和标签匹配"
    />
  );

  if (search.isError) {
    return (
      <>
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
        <CommandGroups commands={matchedCommands}>{galleryItem}</CommandGroups>
      </>
    );
  }

  if (loading) return <PaletteSkeleton rows={5} />;

  const empty = hits.length === 0 && matchedCommands.length === 0;

  return (
    <>
      {empty && (
        <EmptyState
          glyph="无"
          title={`没有找到「${query}」`}
          description="换个写法试试：中文名、日文名、罗马音、Danbooru 标签都可以。"
          className="py-10"
        />
      )}

      {chars.length > 0 && (
        <Command.Group heading={<GroupHeading title="角色" extra={chars.length >= 20 ? '20+' : chars.length} />}>
          {chars.slice(0, MAX_CHARACTERS).map((h) => (
            <CharacterRow key={h.character.id} hit={h} query={query} onSelect={actions.openCharacter} />
          ))}
          {chars.length > MAX_CHARACTERS && (
            <PaletteItem
              value="more:characters"
              onSelect={() => actions.go(`/characters?${new URLSearchParams({ q: query })}`)}
              leading={<IconTile icon={UsersRound} />}
              title="在角色页查看全部匹配"
              subtitle={`还有 ${chars.length - MAX_CHARACTERS}${chars.length >= 20 ? '+' : ''} 位角色`}
            />
          )}
        </Command.Group>
      )}

      {works.length > 0 && (
        <Command.Group heading={<GroupHeading title="作品" extra={works.length} />}>
          {works.map(({ work }) => (
            <PaletteItem
              key={work.id}
              value={`work:${work.id}`}
              onSelect={() => actions.openWork(work)}
              leading={<WorkTile work={work} />}
              title={<Highlight text={work.name} query={query} />}
              subtitle={aliasHint(work.aliases, work.danbooruTag, work.name, query)}
              trailing={
                <span>
                  {formatCount(work.characterCount)} 位角色 · {formatCount(work.imageCount)} 张
                </span>
              }
            />
          ))}
        </Command.Group>
      )}

      {tags.length > 0 && (
        <Command.Group heading={<GroupHeading title="标签" extra={tags.length} />}>
          {tags.map(({ tag, imageCount }) => (
            <PaletteItem
              key={tag}
              value={`tag:${tag}`}
              onSelect={() => actions.openTag(tag)}
              leading={<TagTile />}
              title={
                <span className="font-mono text-[13px] font-normal">
                  <Highlight text={tag} query={query} />
                </span>
              }
              subtitle="在图库中筛选"
              trailing={<CountMeta count={imageCount} />}
            />
          ))}
        </Command.Group>
      )}

      <CommandGroups commands={matchedCommands}>{galleryItem}</CommandGroups>
    </>
  );
}

function CharacterRow({
  hit,
  query,
  onSelect,
}: {
  hit: CharacterHit;
  query: string;
  onSelect: SearchActions['openCharacter'];
}) {
  const { character: c, workName } = hit;
  return (
    <PaletteItem
      value={`char:${c.id}`}
      onSelect={() => onSelect(c, workName)}
      leading={<CharacterAvatar name={c.name} coverImageId={c.coverImageId} coverFocus={c.coverFocus} coverRating={c.coverRating} />}
      title={<Highlight text={c.name} query={query} />}
      subtitle={<Dotted parts={[workName, aliasHint(c.aliases, c.danbooruTag, c.name, query)]} />}
      trailing={<CountMeta count={c.imageCount} newCount={c.newCount} />}
    />
  );
}

/**
 * 名字没命中时，把真正命中的那个别名 / Danbooru 标签亮出来（搜 mika 能看出为什么出现「圣园未花」）；
 * 否则就显示前两个别名。都没有时返回 null，Dotted 据此省掉多余的分隔点。
 */
function aliasHint(aliases: string[], tag: string | null, name: string, query: string): ReactNode {
  const q = query.toLowerCase();
  if (!name.toLowerCase().includes(q)) {
    const alias = aliases.find((a) => a.toLowerCase().includes(q));
    if (alias) return <Highlight text={alias} query={query} />;
    if (tag?.toLowerCase().includes(q)) {
      return (
        <span className="font-mono text-[11.5px]">
          <Highlight text={tag} query={query} />
        </span>
      );
    }
  }
  const shown = aliases.slice(0, 2).join(' / ');
  return shown ? <span className="text-fg-subtle">{shown}</span> : null;
}
