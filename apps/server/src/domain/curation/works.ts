/**
 * 图 ↔ 作品（手动指定，image_copyrights）：P3b 起图的作品只来自关联的角色、手动指定的作品和原创标记（v_image_works，附录 #8）；
 * 模型给的作品是证据（work_evidence，证据模块）。这张表只在 domain/curation/ 里写。
 */
import type { Db } from '../../db/connection.ts';
import { stmt } from '../tx.ts';

/** 作品合并（编目收拢改过名的作品时）：手动指定到 from 的图改指定到 to（已有的不重复） */
export function moveWorkLinks(db: Db, from: number, to: number): void {
  stmt(db, 'INSERT OR IGNORE INTO image_copyrights (image_id, work_id) SELECT image_id, @to FROM image_copyrights WHERE work_id = @from').run({ from, to });
}
