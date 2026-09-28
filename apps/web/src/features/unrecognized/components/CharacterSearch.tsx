import { CornerDownLeft, Plus } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { Chip, ChipAvatar, Kbd, SearchInput, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useSearch } from '@/lib/queries';
import { useDebounced } from '../hooks';
import type { AssignTarget } from '../types';

/**
 * 「搜索其他角色」：按 / 聚焦，↑↓ 选择，回车归入。
 * 结果直接在面板里展开（面板本身会滚动，浮层反而会被裁掉）。
 * 输入为空时列出本次会话用过的角色——整理时常常是连着好几张同一个人。
 */
export function CharacterSearch({
  inputRef,
  recent,
  onPick,
  onCreate,
  placeholder = '搜索其他角色…',
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  recent: AssignTarget[];
  onPick: (t: AssignTarget) => void;
  /** 传了就在结果末尾加「新建自建角色「xxx」并归入」（T34c） */
  onCreate?: (name: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 150);
  const search = useSearch(term);

  const results = useMemo<AssignTarget[]>(() => {
    if (!term) return [];
    return (search.data ?? []).flatMap((hit) =>
      hit.type === 'character'
        ? [
            {
              id: hit.character.id,
              name: hit.character.name,
              workName: hit.workName,
              coverImageId: hit.character.coverImageId,
              coverRating: hit.character.coverRating,
              imageCount: hit.character.imageCount,
            },
          ]
        : [],
    ).slice(0, 6);
  }, [term, search.data]);

  const typing = q.trim().length > 0;
  const list = typing ? results : recent;
  const searching = typing && (term !== q.trim() || search.isFetching) && !results.length;
  // 结果回来之后才出现，免得手快回车误开新建（RV-T-14 ③）
  const canCreate = !!onCreate && typing && !searching && term === q.trim() && !results.some((r) => r.name === q.trim());
  const count = list.length + (canCreate ? 1 : 0);
  const activeIndex = Math.min(active, Math.max(0, count - 1));

  // 换了一批结果就回到第一条
  useEffect(() => setActive(0), [term, focused]);

  const pick = (t: AssignTarget | undefined) => {
    if (!t) return;
    onPick(t);
    setQ('');
    // 失焦后数字键 / J / K 这些快捷键才会重新生效
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!count) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + d + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      if (canCreate && activeIndex === list.length) create();
      else pick(list[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q) setQ('');
      else inputRef.current?.blur();
    }
  };

  const create = () => {
    const name = q.trim();
    setQ('');
    inputRef.current?.blur();
    onCreate?.(name);
  };
  const showList = focused && (typing || recent.length > 0);

  return (
    <div>
      <SearchInput
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onClear={() => setQ('')}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        aria-label="搜索角色"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        size="lg"
        trailing={!focused && !q ? <Kbd>/</Kbd> : undefined}
      />

      {showList && (
        <div
          role="listbox"
          aria-label={typing ? '搜索结果' : '本次用过的角色'}
          className="mt-2 animate-fade-in overflow-hidden rounded-[14px] bg-raised py-1.5 shadow-[0_0_0_1px_var(--c-line),var(--shadow-card)]"
        >
          <div className="px-3.5 pt-1 pb-1.5 text-[11px] font-semibold text-fg-subtle">
            {typing ? '搜索结果' : '本次用过的角色'}
          </div>
          {list.map((t, i) => (
            <button
              key={t.id}
              role="option"
              aria-selected={i === activeIndex}
              // 保持焦点在输入框里，否则点击前就失焦把列表收起来了
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(t)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors duration-100',
                i === activeIndex && 'bg-hover',
              )}
            >
              <ChipAvatar image={t.coverImageId ? { id: t.coverImageId, rating: t.coverRating ?? 'general' } : null} label={t.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{t.name}</span>
                <span className="block truncate text-[11.5px] text-fg-muted tabular">
                  {t.workName ?? '未知作品'}
                  {t.imageCount !== undefined && ` · ${formatCount(t.imageCount)} 张`}
                </span>
              </span>
              {i === activeIndex && <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle" />}
            </button>
          ))}
          {searching && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 text-[12.5px] text-fg-subtle">
              <Spinner className="size-3.5" />
              搜索中…
            </div>
          )}
          {typing && !searching && !results.length && !canCreate && (
            <div className="px-3.5 py-2.5 text-[12.5px] text-fg-muted">没有找到「{q.trim()}」</div>
          )}
          {canCreate && (
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === list.length}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(list.length)}
              onClick={create}
              className={cn(
                'flex h-10 w-full items-center gap-2.5 rounded-[12px] px-3.5 text-left text-[12.5px] text-fg-muted transition-colors hover:bg-hover hover:text-fg',
                activeIndex === list.length && 'bg-hover text-fg',
              )}
            >
              <Plus className="size-4" />
              新建自建角色「{q.trim()}」并归入
            </button>
          )}
        </div>
      )}

      {/* 没聚焦时，用过的角色摊成一排 chip，鼠标一点就归入 */}
      {!showList && recent.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {recent.map((t) => (
            <Chip
              key={t.id}
              size="sm"
              leading={
                <ChipAvatar image={t.coverImageId ? { id: t.coverImageId, rating: t.coverRating ?? 'general' } : null} label={t.name} />
              }
              onClick={() => onPick(t)}
              className="max-w-full [&_span]:truncate"
            >
              {t.name}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
