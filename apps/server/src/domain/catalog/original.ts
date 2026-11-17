/**
 * 「原创」作品（标签 original）只有这一种建法（附录 #7）：没有就和识别器建作品走同一个函数（按词库起名、配色、写自动别名），
 * 有撤销记录器时撤销会删掉它。手动归为原创、自动标原创（D8）都先调这里，图算不算「原创」作品由 original_at 派生（v_image_works）
 */
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';

/** 「原创」作品的 Danbooru 标签 */
export const ORIGINAL_WORK_TAG = 'original';

export function ensureOriginalWork(catalog: CharacterCatalog, u: UndoRecorder | null, now: string): number {
  const w = catalog.ensureWork(ORIGINAL_WORK_TAG, now);
  if (w.created && u) {
    // 撤销逆序：先删作品的别名，再删作品
    u.inserted('works', w.id);
    u.sql("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?", [w.id]);
  }
  return w.id;
}
