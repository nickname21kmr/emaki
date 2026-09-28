import type { Character, ID } from '@emaki/shared';
import { Check } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { ChipAvatar, SearchInput, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useSearch } from '@/lib/queries';
import { FieldLabel, Hint } from './RuleFields';

export interface PickedCharacter {
  id: ID;
  name: string;
  workName: string | null;
  imageCount: number;
}

/**
 * 搜索并选中一个角色。↑↓ 移动高亮，Enter 选中高亮项（已选中时 Enter 交给表单提交）。
 */
export function CharacterPicker({
  value,
  onChange,
}: {
  value: PickedCharacter | null;
  onChange: (v: PickedCharacter | null) => void;
}) {
  const [q, setQ] = useState('');
  const [highlight, setHighlight] = useState(0);
  const query = q.trim();
  const search = useSearch(query);
  // keepPreviousData 会在清空输入后仍留着旧结果，这里按输入是否为空兜一下
  const hits = query
    ? (search.data ?? [])
        .flatMap((h) => (h.type === 'character' ? [{ character: h.character, workName: h.workName }] : []))
        .slice(0, 6)
    : [];

  const pick = (c: Character, workName: string | null) =>
    onChange({ id: c.id, name: c.name, workName, imageCount: c.imageCount });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!hits.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + d + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      const hit = hits[Math.min(highlight, hits.length - 1)];
      // 高亮项还没被选中 → 选中它；已经选中 → 放行，让表单提交
      if (hit && hit.character.id !== value?.id) {
        e.preventDefault();
        pick(hit.character, hit.workName);
      }
    }
  };

  return (
    <div>
      <FieldLabel htmlFor="rule-character">角色</FieldLabel>
      <SearchInput
        id="rule-character"
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setHighlight(0);
        }}
        onClear={() => setQ('')}
        onKeyDown={onKeyDown}
        placeholder="搜索角色名、别名或作品"
        autoComplete="off"
        trailing={
          search.isFetching && query ? (
            <span className="flex text-fg-subtle [&_svg]:size-3.5">
              <Spinner />
            </span>
          ) : undefined
        }
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls="rule-character-list"
      />

      {query ? (
        hits.length ? (
          <div id="rule-character-list" role="listbox" className="mt-2 space-y-0.5">
            {hits.map(({ character: c, workName }, i) => {
              const selected = value?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(c, workName)}
                  className={cn(
                    'flex h-11 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors duration-150',
                    selected ? 'bg-shu-soft' : i === highlight ? 'bg-hover' : '',
                  )}
                >
                  <ChipAvatar
                    image={c.coverImageId ? { id: c.coverImageId, rating: c.coverRating, color: c.coverColor } : null}
                    label={c.name}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                    {c.name}
                    {workName && <span className="ml-2 text-[12px] font-normal text-fg-subtle">{workName}</span>}
                  </span>
                  <span className="shrink-0 text-[12px] text-fg-subtle tabular">{formatCount(c.imageCount)} 张</span>
                  <Check className={cn('size-4 shrink-0 text-shu', selected ? 'opacity-100' : 'opacity-0')} />
                </button>
              );
            })}
          </div>
        ) : (
          !search.isFetching && <Hint>没有找到「{query}」</Hint>
        )
      ) : value ? null : (
        <Hint>选中后，这个角色的全部插画都会被排除。</Hint>
      )}

      {value && (
        <p className="mt-3 text-[12.5px] text-fg-muted">
          将排除 <span className="font-semibold text-fg">{value.name}</span>
          {value.workName && <span className="text-fg-subtle"> · {value.workName}</span>} 的{' '}
          <span className="tabular">{formatCount(value.imageCount)}</span> 张插画
        </p>
      )}
    </div>
  );
}
