import { Fragment, type ReactNode } from 'react';
import { useHotkey } from '@/lib/hotkeys';
import { useDisabledEntries } from '@/lib/plugins';
import { entryKey, SLOTS, type SlotEntryId, type SlotId } from './slots';

/** 每个条目怎么画：页面把自己的状态、回调闭包进来；返回 null = 这次不显示 */
export type SlotRenderers<S extends SlotId> = Record<SlotEntryId<S>, () => ReactNode>;

/** 这一处现在要画的条目 id（按登记的顺序，去掉停用的插件拥有的） */
export function slotEntries<S extends SlotId>(id: S, disabled: ReadonlySet<string>): SlotEntryId<S>[] {
  return SLOTS[id].entries.map((x) => x.id as SlotEntryId<S>).filter((x) => !disabled.has(x));
}

/**
 * 条目的快捷键：按键从登记里取（slots.ts 的 key），条目不画（停用的插件拥有的）时不响应。
 * 和 useHotkey 一样的参数，只是按键换成条目的 id
 */
export function useEntryHotkey(
  id: string,
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; allowInInputs?: boolean; preventDefault?: boolean; repeat?: boolean } = {},
) {
  const disabled = useDisabledEntries();
  const key = entryKey(id);
  if (!key) throw new Error(`条目「${id}」没有登记快捷键（blocks/slots.ts）`);
  useHotkey(key, handler, { ...opts, enabled: (opts.enabled ?? true) && !disabled.has(id) });
}

/**
 * 按登记（blocks/slots.ts）的顺序画一处的条目，和区块的 PageBlocks 同一个做法（docs/plugins.md 9.2，E3）。
 * 不加包裹元素：工具栏的 gap、菜单的分隔、信息栏的间距都和以前一样。停用的插件拥有的条目不画。
 * plugins：装的插件加的条目（12.7），放在登记的 pluginsBefore 前面
 */
export function Slot<S extends SlotId>({ id, render, plugins }: { id: S; render: SlotRenderers<S>; plugins?: ReactNode }) {
  const disabled = useDisabledEntries();
  const order: readonly string[] = SLOTS[id].entries.map((x) => x.id);
  const before: string | undefined = (SLOTS[id] as { pluginsBefore?: string }).pluginsBefore;
  const cut = before === undefined ? order.length : order.indexOf(before);
  const ids = slotEntries(id, disabled);
  const draw = (x: SlotEntryId<S>) => <Fragment key={x}>{render[x]()}</Fragment>;
  return (
    <>
      {ids.filter((x) => order.indexOf(x) < cut).map(draw)}
      {plugins}
      {ids.filter((x) => order.indexOf(x) >= cut).map(draw)}
    </>
  );
}
