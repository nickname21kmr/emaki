import { Fragment, type ReactNode } from 'react';
import { useDisabledEntries } from '@/lib/plugins';
import { SLOTS, type SlotEntryId, type SlotId } from './slots';

/** 每个条目怎么画：页面把自己的状态、回调闭包进来；返回 null = 这次不显示 */
export type SlotRenderers<S extends SlotId> = Record<SlotEntryId<S>, () => ReactNode>;

/** 这一处现在要画的条目 id（按登记的顺序，去掉停用的插件拥有的） */
export function slotEntries<S extends SlotId>(id: S, disabled: ReadonlySet<string>): SlotEntryId<S>[] {
  return SLOTS[id].entries.map((x) => x.id as SlotEntryId<S>).filter((x) => !disabled.has(x));
}

/**
 * 按登记（blocks/slots.ts）的顺序画一处的条目，和区块的 PageBlocks 同一个做法（docs/plugins.md 9.2，E3）。
 * 不加包裹元素：工具栏的 gap、菜单的分隔、信息栏的间距都和以前一样。停用的插件拥有的条目不画。
 */
export function Slot<S extends SlotId>({ id, render }: { id: S; render: SlotRenderers<S> }) {
  const disabled = useDisabledEntries();
  return (
    <>
      {slotEntries(id, disabled).map((x) => (
        <Fragment key={x}>{render[x]()}</Fragment>
      ))}
    </>
  );
}
