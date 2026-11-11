import { AUTO_COLLAPSE_MIN, type CollectionSummary, type ID, type ImageItem } from '@emaki/shared';
import { Command } from 'cmdk';
import { CornerDownLeft, Layers, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Dialog, IconButton, Kbd, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, Skeleton } from '@/components/ui';
import { useDebounced } from '@/features/gallery/useDebounced';
import { api } from '@/lib/api';
import { shouldBlur } from '@/lib/blur';
import { cn } from '@/lib/cn';
import { displayTitle, groupOrigin } from '@/lib/collections';
import { formatCount } from '@/lib/format';
import { useCollections, useMutate } from '@/lib/queries';
import { useBlurPrefs, usePrefs, useSelection, type CollapseMode } from '@/lib/stores';
import { Thumb } from './Thumb';

/**
 * 组图的共用件：网格里的收拢角标、收拢开关、「收进组图」弹窗。
 *
 * 收拢后一格代表一组：勾选、收藏、看图器都按这一格背后的成员（collectionGroup.memberIds）算。
 */

/** 这一格代表的图：收拢的组图是命中的全部成员，普通格子就是自己 */
export const selectionIds = (image: ImageItem): ID[] => image.collectionGroup?.memberIds ?? [image.id];

/** 勾选 / 取消一格：组图整组进出 */
export const toggleImageSelection = (image: ImageItem) => {
  const store = useSelection.getState();
  const ids = selectionIds(image);
  const next = new Set(store.ids);
  if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  store.setMany([...next]);
  useSelection.setState({ anchor: image.id });
};

/**
 * 收拢组图（全局偏好，图库、角色、作品、未识别共用）：自动 / 总是收拢 / 总是逐张。
 * 自动 = 当前筛选超过 AUTO_COLLAPSE_MIN 张才收拢，结果少时逐张展开。按钮着色表示当前列表正收拢着（collapsed 来自接口）。
 */
export function CollapseGroupsMenu({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  const mode = usePrefs((s) => s.collapseMode);
  const set = usePrefs((s) => s.setCollapseMode);
  const on = mode === 'on' || (mode === 'auto' && !!collapsed);
  return (
    <Menu
      width={236}
      align="end"
      trigger={
        <IconButton size="sm" active={on} label={on ? '组图收拢着：同一组只占一格' : '组图逐张显示'} className={className}>
          <Layers />
        </IconButton>
      }
    >
      <MenuLabel>收拢组图：同一组只占一格</MenuLabel>
      <MenuRadioGroup value={mode} onValueChange={(v) => set(v as CollapseMode)}>
        <MenuRadioItem value="auto">
          自动
          <span className="ml-2 text-[11.5px] text-fg-subtle">超过 {formatCount(AUTO_COLLAPSE_MIN)} 张时收拢</span>
        </MenuRadioItem>
        <MenuRadioItem value="on">总是收拢</MenuRadioItem>
        <MenuRadioItem value="off">总是逐张</MenuRadioItem>
      </MenuRadioGroup>
    </Menu>
  );
}

/**
 * 收拢格右上角的张数：和模糊角标同一种小圆角（网格里不用 backdrop-filter，原则 6）。
 * 图被模糊时让到模糊角标左边。点它去组图页；点格子本身照常打开看图器。
 */
export function GroupBadge({ image, forceBlur }: { image: ImageItem; forceBlur?: boolean }) {
  const prefs = useBlurPrefs();
  const g = image.collectionGroup;
  if (!g) return null;
  const blurred = shouldBlur(image, prefs) || (!!forceBlur && prefs.blurSensitive);
  const partial = g.count < g.total;
  const title = g.title ?? '无题';
  return (
    <Link
      to={`/collections/${g.id}`}
      state={partial ? { collectionMembers: g.memberIds } : undefined}
      onClick={(e) => e.stopPropagation()}
      aria-label={`组图《${title}》，${partial ? `这里有 ${g.count} 张，整组 ${g.total} 张` : `${g.total} 张`}，打开组图`}
      title={partial ? `《${title}》：这里有 ${g.count} 张，整组 ${g.total} 张` : `《${title}》 · ${g.total} 张`}
      className={cn(
        'absolute top-1.5 z-10 flex h-5 items-center gap-1 rounded-full bg-black/40 pr-2 pl-1.5 text-[11px] font-semibold text-white/95 tabular',
        'transition-colors duration-150 hover:bg-black/60',
        blurred ? 'right-8' : 'right-1.5',
      )}
    >
      <Layers className="size-3" aria-hidden />
      {partial ? `${g.count}/${g.total}` : g.total}
    </Link>
  );
}

/**
 * 收进组图：搜索已有的组图，或输入名字新建。只改整理信息，不移动文件。
 * 只列组图：本子、画集跟着文件夹走，不收别处的图。
 */
export function AddToGroupDialog({
  open,
  onOpenChange,
  ids,
  onDone,
  excludeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: ID[];
  onDone?: () => void;
  /** 当前所在的组图（从组图里「另建组图」时不列它自己） */
  excludeId?: ID;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="收进组图"
      description={`${formatCount(ids.length)} 张 · 只改整理信息，不移动文件；原来在别的组图里的会移过来`}
      width={460}
      className="pb-0!"
    >
      {open && (
        <GroupPickerPanel
          ids={ids}
          excludeId={excludeId}
          onDone={() => {
            onOpenChange(false);
            onDone?.();
          }}
        />
      )}
    </Dialog>
  );
}

function GroupPickerPanel({ ids, excludeId, onDone }: { ids: ID[]; excludeId?: ID; onDone: () => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 120);
  const list = useCollections({});
  const add = useMutate((target: ID) => api.updateCollection(target, { addImageIds: ids }), { onSuccess: onDone });
  const create = useMutate((title: string) => api.createCollection({ imageIds: ids, kind: 'group', title }), { onSuccess: onDone });
  const busy = add.isPending || create.isPending;

  const groups = useMemo(() => {
    const all = (list.data ?? []).filter((c) => c.kind === 'group' && c.id !== excludeId);
    const key = q.toLowerCase();
    const hit = key ? all.filter((c) => displayTitle(c).toLowerCase().includes(key)) : all;
    // 手动收集的在前，再按最近加图排
    return hit
      .sort((a, b) => Number(b.membership !== 'post') - Number(a.membership !== 'post') || (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? ''))
      .slice(0, 50);
  }, [list.data, q, excludeId]);
  const canCreate = !!q && !groups.some((c) => displayTitle(c) === q);

  const [active, setActive] = useState('');
  const first = canCreate ? 'create' : (groups[0]?.id ?? '');
  useEffect(() => setActive(first), [first]);

  return (
    <Command shouldFilter={false} loop value={active} onValueChange={setActive} label="选择组图" className="-mx-6">
      <div className="px-6 pb-3">
        <label className="flex h-9 items-center gap-2 rounded-full bg-sunken px-3.5 transition-shadow focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]">
          <Search className="size-4 shrink-0 text-fg-subtle" />
          <Command.Input
            value={text}
            onValueChange={setText}
            placeholder="搜索组图，或输入名字新建"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg-subtle"
          />
        </label>
      </div>

      <Command.List className="max-h-[min(320px,46vh)] overflow-y-auto overscroll-contain border-t border-line px-4 py-1.5 scrollbar-thin">
        {list.isPending && (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-11 rounded-lg" />
            ))}
          </div>
        )}
        {canCreate && (
          <Command.Item
            value="create"
            disabled={busy}
            onSelect={() => create.mutate(q)}
            className="flex h-12 cursor-pointer items-center gap-3 rounded-lg px-2 text-[13.5px] outline-none data-[selected=true]:bg-hover"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-sunken text-fg-muted ring-1 ring-line">
              <Plus className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              新建组图「<span className="font-medium">{q}</span>」
            </span>
            <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle" />
          </Command.Item>
        )}
        {groups.map((c) => (
          <GroupRow key={c.id} c={c} disabled={busy} onSelect={() => add.mutate(c.id)} />
        ))}
        {!list.isPending && !groups.length && !canCreate && (
          <div className="px-4 py-8 text-center text-[13px] text-fg-muted">
            {q ? `没有叫「${q}」的组图` : '还没有组图'}
            <div className="mt-1 text-xs text-fg-subtle">输入名字，回车新建一个</div>
          </div>
        )}
      </Command.List>

      <div className="flex items-center gap-3 border-t border-line px-6 py-2.5 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          收进去
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>Esc</Kbd>
          关闭
        </span>
      </div>
    </Command>
  );
}

function GroupRow({ c, disabled, onSelect }: { c: CollectionSummary; disabled: boolean; onSelect: () => void }) {
  const cover = c.covers[0];
  return (
    <Command.Item
      value={c.id}
      disabled={disabled}
      onSelect={onSelect}
      className="group flex h-12 cursor-default items-center gap-3 rounded-lg px-2 outline-none select-none data-[disabled=true]:opacity-55 data-[selected=true]:bg-hover"
    >
      <span className="relative size-8 shrink-0 overflow-hidden rounded-[9px] bg-sunken ring-1 ring-line">
        {cover && <Thumb image={{ id: cover.imageId, rating: cover.rating, dominantColor: cover.color ?? 'var(--c-sunken)' }} width={240} blurBadge="none" className="size-full" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] leading-tight font-medium">{displayTitle(c)}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-fg-subtle tabular">
          {formatCount(c.pageCount)} 张 · {groupOrigin(c)}
        </div>
      </div>
      <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-data-[selected=true]:opacity-100" />
    </Command.Item>
  );
}
