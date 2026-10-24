import type { ID } from '@emaki/shared';
import { useEffect, useMemo } from 'react';
import { useSelection } from '@/lib/stores';

export const SINGLES_SCOPE = 'excluded';

const EMPTY: ReadonlySet<ID> = new Set();

/**
 * 「单张图片」区的多选，走全局 useSelection（作用域 excluded），助手才看得到选了哪些。
 * ids 变化（恢复后图片消失）时自动忽略已经不存在的选中项。
 */
export function useSinglesSelection(ids: ID[]) {
  useEffect(() => {
    useSelection.getState().setScope(SINGLES_SCOPE);
    // 离开页面就放下，别的页面的助手不会还带着这几张
    return () => {
      const s = useSelection.getState();
      if (s.scope === SINGLES_SCOPE) s.clear();
    };
  }, []);

  const picked = useSelection((s) => (s.scope === SINGLES_SCOPE ? s.ids : EMPTY));
  const selected = useMemo(() => {
    const alive = new Set(ids);
    return new Set([...picked].filter((id) => alive.has(id)));
  }, [picked, ids]);

  // 恢复掉的图从全局选择里也拿掉，助手那边不会还带着它们
  useEffect(() => {
    useSelection.getState().retain(SINGLES_SCOPE, ids);
  }, [ids, picked]);

  const store = () => {
    const s = useSelection.getState();
    s.setScope(SINGLES_SCOPE);
    return s;
  };

  const toggle = (id: ID) => store().toggle(id);
  /** Shift+点击：从上一次点的那张连选到这张 */
  const range = (id: ID) => store().selectRange(ids, id);
  const selectAll = () => store().setMany(ids);
  const clear = () => store().clear();

  return { selected, toggle, range, selectAll, clear };
}

export type SinglesSelection = ReturnType<typeof useSinglesSelection>;
