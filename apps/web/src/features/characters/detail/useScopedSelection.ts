import type { ID, ImageItem } from '@emaki/shared';
import { useMemo } from 'react';
import { useHotkey } from '@/lib/hotkeys';
import { useLightbox, useSelection } from '@/lib/stores';

/**
 * 某个选择作用域（例如 `character:c1`）里的已选图片 + 快捷键：
 *   Esc     取消选择
 *   Ctrl+A  全选当前已加载的
 *
 * blocked：有弹窗打开时传 true，避免 Esc 同时关弹窗又清选择。
 */
export function useScopedSelection(scope: string, images: ImageItem[], blocked = false) {
  const storeScope = useSelection((s) => s.scope);
  const storeIds = useSelection((s) => s.ids);
  const lightboxOpen = useLightbox((s) => s.open);

  const ids = useMemo<ID[]>(() => (storeScope === scope ? [...storeIds] : []), [storeScope, storeIds, scope]);
  const idle = blocked || lightboxOpen;

  const clear = () => useSelection.getState().clear();
  const selectAll = () => {
    const s = useSelection.getState();
    s.setScope(scope);
    s.setMany(images.map((i) => i.id));
  };

  useHotkey('esc', clear, { enabled: ids.length > 0 && !idle, preventDefault: false });
  useHotkey('mod+a', selectAll, { enabled: images.length > 0 && !idle });

  return { ids, count: ids.length, clear, selectAll };
}
