import type { Artist, BulkImageAction, ID } from '@emaki/shared';
import { Command } from 'cmdk';
import { Check, CornerDownLeft, Plus, Search } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { Kbd, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { api } from '@/lib/api';
import { useArtists, useMutate } from '@/lib/queries';

/**
 * 画师选择器（带搜索的弹出框）：从认出过的画师里挑，名字、标签、别名、推特都能搜；
 * 库里没有的画师，直接用输入的名字（服务端规范成小写、空格换下划线）。
 * 看图器「添加画师」、图库多选「改画师…」用它。
 */
export interface ArtistPickerProps {
  /** 触发按钮（asChild） */
  children: ReactNode;
  /** tag：已有画师是它的代表标签，新画师是输入的名字 */
  onPick: (tag: string, name: string) => void;
  /** 这张图已经有的标签：对应的画师显示「已有」且不能再选 */
  selectedTags?: readonly string[];
  title?: ReactNode;
  meta?: ReactNode;
  /** 列表下面的额外操作（例如「没有画师」），只能点，不参与键盘选择 */
  actions?: { key: string; label: string; hint?: string; onSelect: () => void }[];
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ArtistPicker({
  children,
  onPick,
  selectedTags,
  title = '选择画师',
  meta,
  actions,
  side = 'bottom',
  align = 'start',
  open: openProp,
  onOpenChange,
}: ArtistPickerProps) {
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
          <ArtistPickerPanel
            title={title}
            meta={meta}
            selectedTags={selectedTags}
            actions={actions?.map((a) => ({ ...a, onSelect: () => (a.onSelect(), setOpen(false)) }))}
            onPick={(tag, name) => {
              onPick(tag, name);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 不分大小写，下划线和空格算一样 */
const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, ' ').trim();
const keysOf = (a: Artist) => [a.name, a.tag, ...a.tags, ...a.aliases, a.twitter ?? ''].filter(Boolean).map(norm);
/** 不选中任何一项（cmdk 的值为空时会自动选第一项，所以用一个不存在的值） */
const NO_PICK = '__none__';
/** 没输入时列出的常见画师数；输入后最多列出的条数 */
const TOP = 30;
const MAX = 60;

/** 选择器本体（不带弹出框）：合并画师的对话框里直接用它。allowNew = 可以用输入的名字当新画师 */
export function ArtistPickerPanel({
  onPick,
  selectedTags,
  title,
  meta,
  actions,
  allowNew = true,
  selectedLabel = '已有',
  autoHighlight = true,
}: Pick<ArtistPickerProps, 'onPick' | 'selectedTags' | 'title' | 'meta' | 'actions'> & {
  allowNew?: boolean;
  selectedLabel?: string;
  /** false = 输入之前不默认选中第一位（合并画师：打开就按回车不会误合并） */
  autoHighlight?: boolean;
}) {
  const { data, isPending } = useArtists();
  const [text, setText] = useState('');
  const q = norm(text);
  const selected = useMemo(() => new Set(selectedTags ?? []), [selectedTags]);

  const rows = useMemo(() => {
    const list = data ?? [];
    if (!q) return list.slice(0, TOP);
    // 前缀匹配排前面，同档按张数
    const scored = list.flatMap((a) => {
      const keys = keysOf(a);
      const s = keys.some((k) => k.startsWith(q)) ? 2 : keys.some((k) => k.includes(q)) ? 1 : 0;
      return s ? [{ a, s }] : [];
    });
    return scored
      .sort((x, y) => y.s - x.s || y.a.imageCount - x.a.imageCount)
      .slice(0, MAX)
      .map((x) => x.a);
  }, [data, q]);
  // 输入的名字和哪位画师都对不上：可以当新画师
  const fresh = allowNew && text.trim() && !(data ?? []).some((a) => keysOf(a).includes(q)) ? text.trim() : null;
  const has = (a: Artist) => selected.has(a.tag) || a.tags.some((t) => selected.has(t));
  // 默认高亮第一位能选的画师（没有再是「用这个名字」）
  const firstRow = rows.find((a) => !has(a));
  const first = !autoHighlight && !q ? NO_PICK : firstRow ? `artist:${firstRow.tag}` : fresh ? `new:${fresh}` : '';
  const [active, setActive] = useState('');
  useEffect(() => setActive(first), [first]);

  return (
    <Command shouldFilter={false} loop value={active || first} onValueChange={setActive} label="选择画师">
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
            placeholder={allowNew ? '搜名字、日文名或推特，或输入新名字' : '搜名字、日文名或推特'}
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg-subtle"
          />
          {isPending && <Spinner className="size-3.5 text-fg-subtle" />}
        </label>
      </div>

      <Command.List className="max-h-[min(340px,50vh)] overflow-y-auto overscroll-contain px-1.5 pb-1.5 scrollbar-thin">
        {rows.length > 0 && (
          <Command.Group heading={q ? undefined : '常见画师'} className={HEADING}>
            {rows.map((a) => (
              <Command.Item
                key={a.tag}
                value={`artist:${a.tag}`}
                disabled={has(a)}
                onSelect={() => onPick(a.tag, a.name)}
                className={cn(ITEM, 'data-[disabled=true]:opacity-55')}
              >
                <span className="relative size-8 shrink-0 overflow-hidden rounded-[9px] bg-sunken ring-1 ring-line">
                  {a.cover ? (
                    <Thumb image={a.cover} width={240} className="size-full" blurBadge="none" />
                  ) : (
                    <span className="flex size-full items-center justify-center text-[13px] font-medium text-fg-muted">{a.name.slice(0, 1)}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] leading-tight font-medium">{a.name}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-fg-subtle tabular">
                    {formatCount(a.imageCount)} 张
                    {a.twitter ? ` · @${a.twitter}` : a.name !== a.tag.replace(/_/g, ' ') ? ` · ${a.tag}` : ''}
                  </span>
                </span>
                {has(a) ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-subtle">
                    <Check className="size-3.5" />
                    {selectedLabel}
                  </span>
                ) : (
                  <CornerDownLeft className={ENTER} />
                )}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {fresh && (
          <Command.Item value={`new:${fresh}`} onSelect={() => onPick(fresh, fresh)} className={ITEM}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-sunken text-fg-muted ring-1 ring-line">
              <Plus className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">用「{fresh}」</span>
              <span className="block truncate text-[11.5px] text-fg-subtle">库里还没有这位画师，按这个名字记</span>
            </span>
            <CornerDownLeft className={ENTER} />
          </Command.Item>
        )}

        {!isPending && !rows.length && !fresh && (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-fg-subtle">
            {q ? '没有找到这位画师' : allowNew ? '还没有认出过画师，输入名字就能加。' : '还没有认出过画师'}
          </div>
        )}
      </Command.List>

      {/* 「没有画师」「改回自动」这类操作不放进列表：键盘选择、回车只会落在画师上，不会误点 */}
      {actions?.length ? (
        <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              title={a.hint}
              onClick={a.onSelect}
              className="h-7 rounded-md px-2 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

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

const ITEM = cn(
  'group flex min-h-12 cursor-default items-center gap-3 rounded-lg px-2 py-1.5 outline-none select-none',
  'transition-colors duration-100 data-[selected=true]:bg-hover',
);
const ENTER = 'size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-data-[selected=true]:opacity-100';
const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle';

/**
 * 角色、作品、合集页多选栏的「画师…」：那几个选择栏是按钮列表放不下弹出框，选择器挂在屏幕底部中间。
 * 选一位 = 把选中的图都改成这位画师；下面两个操作：没有画师、改回自动识别。
 */
export function ArtistBulkPicker({
  open,
  onOpenChange,
  ids,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: ID[];
  onDone: () => void;
}) {
  const bulk = useMutate((v: { ids: ID[]; action: BulkImageAction }) => api.bulkImages(v), { onSuccess: onDone });
  const run = (action: BulkImageAction) => bulk.mutate({ ids, action });
  return (
    <ArtistPicker
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="center"
      title="改画师"
      meta={`${formatCount(ids.length)} 张`}
      onPick={(tag) => run({ type: 'artist', mode: 'set', artists: [tag] })}
      actions={[
        { key: 'none', label: '没有画师 / 不知道是谁', hint: '去掉认出的画师，以后也不再自动认', onSelect: () => run({ type: 'artist', mode: 'set', artists: [] }) },
        { key: 'auto', label: '改回自动识别', hint: '清掉手动改的，交给「识别画师」重新认', onSelect: () => run({ type: 'artist-auto' }) },
      ]}
    >
      <span className="pointer-events-none fixed bottom-24 left-1/2" />
    </ArtistPicker>
  );
}
