import { Command } from 'cmdk';
import { useTopCharacters, useWorks } from '@/lib/queries';
import type { PaletteCommand } from './commands';
import { CommandGroups } from './CommandGroups';
import { CharacterAvatar, CountMeta, GroupHeading, PaletteItem, PaletteSkeleton } from './items';
import { useRecentCharacters, type RecentCharacter } from './recent';
import type { SearchActions } from './SearchResults';

/**
 * 输入为空时：最近访问的角色（没有就退回「常看的角色」）+ 常用命令。
 */
export function EmptyQuery({ commands, actions }: { commands: PaletteCommand[]; actions: SearchActions }) {
  const recent = useRecentCharacters((s) => s.items);
  return (
    <>
      {recent.length > 0 ? (
        <Command.Group heading={<GroupHeading title="最近访问" />}>
          {recent.map((r) => (
            <RecentRow key={r.id} item={r} onSelect={() => actions.go(`/characters/${r.id}`)} />
          ))}
        </Command.Group>
      ) : (
        <TopFallback actions={actions} />
      )}
      <CommandGroups commands={commands} />
    </>
  );
}

function RecentRow({ item, onSelect }: { item: RecentCharacter; onSelect: () => void }) {
  return (
    <PaletteItem
      value={`char:${item.id}`}
      onSelect={onSelect}
      leading={<CharacterAvatar name={item.name} coverImageId={item.coverImageId} coverFocus={item.coverFocus} coverRating={item.coverRating} />}
      title={item.name}
      subtitle={item.workName ?? undefined}
      trailing={<CountMeta count={item.imageCount} />}
    />
  );
}

/** 第一次用、还没有访问记录时，给几个收藏最多的角色当起点 */
function TopFallback({ actions }: { actions: SearchActions }) {
  const top = useTopCharacters({ limit: 5 });
  const works = useWorks();

  // 这是锦上添花的推荐，失败了就安静地不显示，下面的命令照常可用
  if (top.isError) return null;
  if (!top.data) return <PaletteSkeleton rows={3} />;
  if (top.data.length === 0) return null;

  const workName = (id: string | undefined) => works.data?.find((w) => w.id === id)?.name ?? null;

  return (
    <Command.Group heading={<GroupHeading title="常看的角色" extra="按收藏张数" />}>
      {top.data.map((c) => {
        const wn = workName(c.workIds[0]);
        return (
          <PaletteItem
            key={c.id}
            value={`char:${c.id}`}
            onSelect={() => actions.openCharacter(c, wn)}
            leading={<CharacterAvatar name={c.name} coverImageId={c.coverImageId} coverFocus={c.coverFocus} coverRating={c.coverRating} />}
            title={c.name}
            subtitle={wn ?? undefined}
            trailing={<CountMeta count={c.imageCount} newCount={c.newCount} />}
          />
        );
      })}
    </Command.Group>
  );
}
