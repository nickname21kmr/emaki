import type { Character, ID } from '@emaki/shared';
import { Command } from 'cmdk';
import { Check, CornerDownLeft, Search } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { Kbd, Skeleton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useSearch, useTopCharacters, useWorks } from '@/lib/queries';
import { useRecentCharacters } from './recentCharacters';
import { useDebounced } from './useDebounced';

/**
 * 角色选择器（带搜索的弹出框）。图库多选「归到角色…」、看图器「添加角色」都用它，
 * 其他页面也可以直接拿去用：
 *
 *   <CharacterPicker onPick={(c) => assign(c.id)} selectedIds={image.characterIds}>
 *     <Button>归到角色…</Button>
 *   </CharacterPicker>
 *
 * 输入为空时显示「最近使用」+「常用角色」，输入后走 /api/search。
 * 全程键盘可用：↑↓ 选择，↵ 确认，Esc 关闭。
 */
export interface CharacterPickerProps {
  /** 触发按钮（asChild） */
  children: ReactNode;
  onPick: (character: Character) => void;
  /** 已经关联的角色：显示「已关联」且不能再选 */
  selectedIds?: readonly ID[];
  title?: ReactNode;
  /** 标题右侧的小字，例如「12 张」 */
  meta?: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CharacterPicker({
  children,
  onPick,
  selectedIds,
  title = '归到角色',
  meta,
  side = 'bottom',
  align = 'start',
  open: openProp,
  onOpenChange,
}: CharacterPickerProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={10}
          collisionPadding={16}
          className={cn(
            'z-[70] w-[340px] overflow-hidden rounded-xl bg-raised text-fg shadow-pop ring-1 ring-line',
            'origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-rise',
          )}
        >
          <CharacterPickerPanel
            title={title}
            meta={meta}
            selectedIds={selectedIds}
            onPick={(c) => {
              onPick(c);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface PickerRow {
  character: Character;
  workName: string | null;
  /** 最近使用的是快照，张数可能过时，不显示 */
  showCount: boolean;
}

/** 选择器本体（不带弹出框），想内嵌在别的面板里时直接用它 */
export function CharacterPickerPanel({
  onPick,
  selectedIds,
  title,
  meta,
  className,
}: {
  onPick: (character: Character) => void;
  selectedIds?: readonly ID[];
  title?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 160);
  const typing = text.trim() !== q;

  const search = useSearch(q);
  const top = useTopCharacters({ limit: 8 });
  const works = useWorks();
  const recents = useRecentCharacters((s) => s.items);
  const pushRecent = useRecentCharacters((s) => s.push);

  const workName = useMemo(() => {
    const map = new Map((works.data ?? []).map((w) => [w.id, w.name]));
    return (c: Character) => (c.workIds[0] ? (map.get(c.workIds[0]) ?? null) : null);
  }, [works.data]);

  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

  // 输入为空：最近使用 + 常用；有输入：搜索结果
  const groups = useMemo<{ heading: string; rows: PickerRow[] }[]>(() => {
    if (q) {
      const rows = (search.data ?? []).flatMap((hit) =>
        hit.type === 'character' ? [{ character: hit.character, workName: hit.workName, showCount: true }] : [],
      );
      return [{ heading: '搜索结果', rows }];
    }
    const recentIds = new Set(recents.map((c) => c.id));
    return [
      {
        heading: '最近使用',
        rows: recents.map((c) => ({ character: c, workName: workName(c), showCount: false })),
      },
      {
        heading: '常用角色',
        rows: (top.data ?? [])
          .filter((c) => !recentIds.has(c.id))
          .map((c) => ({ character: c, workName: workName(c), showCount: true })),
      },
    ].filter((g) => g.rows.length > 0);
  }, [q, search.data, recents, top.data, workName]);

  const flat = groups.flatMap((g) => g.rows);
  const firstPickable = flat.find((r) => !selected.has(r.character.id))?.character.id ?? '';

  // 结果变化时高亮第一项，保证直接回车就能选中
  const [active, setActive] = useState('');
  useEffect(() => {
    setActive(firstPickable);
  }, [firstPickable, q]);

  const loading = q ? (search.isPending || typing) && !search.data : top.isPending && recents.length === 0;
  const empty = !loading && !typing && flat.length === 0;

  const pick = (c: Character) => {
    if (selected.has(c.id)) return;
    pushRecent(c);
    onPick(c);
  };

  return (
    <Command shouldFilter={false} loop value={active} onValueChange={setActive} label="选择角色" className={className}>
      {(title || meta) && (
        <div className="flex items-baseline justify-between px-4 pt-3.5 pb-2">
          <div className="text-[13px] font-semibold tracking-tight">{title}</div>
          {meta && <div className="text-xs text-fg-subtle tabular">{meta}</div>}
        </div>
      )}

      <div className={cn('px-3 pb-2', !(title || meta) && 'pt-3')}>
        <label className="flex h-9 items-center gap-2 rounded-full bg-sunken px-3.5 transition-shadow focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]">
          <Search className="size-4 shrink-0 text-fg-subtle" />
          <Command.Input
            value={text}
            onValueChange={setText}
            autoFocus
            placeholder="搜索名字、别名或作品"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg-subtle"
          />
          {q && search.isFetching && <Spinner className="size-3.5 text-fg-subtle" />}
        </label>
      </div>

      <Command.List className="max-h-[min(340px,50vh)] overflow-y-auto overscroll-contain px-1.5 pb-1.5 scrollbar-thin">
        {loading && <PickerSkeleton />}

        {empty && (
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] font-medium">{q ? `没有找到「${q}」` : '还没有角色'}</div>
            <div className="mt-1 text-xs leading-relaxed text-fg-subtle">
              {q ? '试试日文名、英文名或作品名；也可以去「角色」页新建自建角色。' : '扫描并识别图片后，角色会出现在这里。'}
            </div>
          </div>
        )}

        {!loading &&
          groups.map((g) => (
            <Command.Group
              key={g.heading}
              heading={g.heading}
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle"
            >
              {g.rows.map((row) => (
                <PickerItem
                  key={row.character.id}
                  row={row}
                  assigned={selected.has(row.character.id)}
                  onSelect={() => pick(row.character)}
                />
              ))}
            </Command.Group>
          ))}
      </Command.List>

      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          确认
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>Esc</Kbd>
          关闭
        </span>
      </div>
    </Command>
  );
}

function PickerItem({ row, assigned, onSelect }: { row: PickerRow; assigned: boolean; onSelect: () => void }) {
  const c = row.character;
  return (
    <Command.Item
      value={c.id}
      disabled={assigned}
      onSelect={onSelect}
      className={cn(
        'group flex h-12 cursor-default items-center gap-3 rounded-lg px-2 outline-none select-none',
        'transition-colors duration-100 data-[selected=true]:bg-hover data-[disabled=true]:opacity-55',
      )}
    >
      <CharacterAvatar character={c} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] leading-tight font-medium">{c.name}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-fg-subtle tabular">
          {row.workName ?? (c.source === 'custom' ? '自建角色' : '未归属作品')}
          {row.showCount && ` · ${formatCount(c.imageCount)} 张`}
        </div>
      </div>
      {assigned ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-subtle">
          <Check className="size-3.5" />
          已关联
        </span>
      ) : (
        <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-data-[selected=true]:opacity-100" />
      )}
    </Command.Item>
  );
}

/** 角色小封面（默认 32px 圆角方形，circle 为圆形）；没有封面时用名字首字 */
export function CharacterAvatar({
  character,
  size = 32,
  shape = 'square',
  className,
}: {
  // 最近使用的快照里可能没有 coverRating（旧数据），按 general 处理
  character: Pick<Character, 'name' | 'coverImageId' | 'coverFocus'> & { coverRating?: Character['coverRating'] };
  size?: number;
  shape?: 'square' | 'circle';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'relative shrink-0 overflow-hidden bg-sunken ring-1 ring-line',
        shape === 'circle' ? 'rounded-full' : 'rounded-[9px]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {character.coverImageId ? (
        <Thumb
          image={{ id: character.coverImageId, dominantColor: 'var(--c-sunken)', rating: character.coverRating ?? 'general' }}
          width={240}
          focus={character.coverFocus}
          className="size-full"
        />
      ) : (
        <span
          className="flex size-full items-center justify-center font-medium text-fg-muted"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          {character.name.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

function PickerSkeleton() {
  return (
    <div className="px-2 pt-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-12 items-center gap-3">
          <Skeleton className="size-8 rounded-[9px]" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 rounded-full" style={{ width: `${46 - i * 6}%` }} />
            <Skeleton className="h-2.5 w-1/4 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
