import type { ID } from '@emaki/shared';
import { useMemo, useRef, useState } from 'react';

/**
 * 「单张图片」区的多选（页面内局部状态，不占用全局 useSelection）。
 * ids 变化（恢复后图片消失）时自动忽略已经不存在的选中项。
 */
export function useSinglesSelection(ids: ID[]) {
  const [picked, setPicked] = useState<ReadonlySet<ID>>(() => new Set());
  const anchor = useRef<ID | null>(null);
  const selected = useMemo(() => {
    const alive = new Set(ids);
    return new Set([...picked].filter((id) => alive.has(id)));
  }, [picked, ids]);

  const toggle = (id: ID) => {
    anchor.current = id;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Shift+点击：从上一次点的那张连选到这张 */
  const range = (id: ID) => {
    const from = anchor.current ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    if (from < 0 || to < 0) return toggle(id);
    const [a, b] = from < to ? [from, to] : [to, from];
    anchor.current = id;
    setPicked((prev) => new Set([...prev, ...ids.slice(a, b + 1)]));
  };

  const selectAll = () => setPicked(new Set(ids));
  const clear = () => {
    anchor.current = null;
    setPicked(new Set());
  };

  return { selected, toggle, range, selectAll, clear };
}

export type SinglesSelection = ReturnType<typeof useSinglesSelection>;
