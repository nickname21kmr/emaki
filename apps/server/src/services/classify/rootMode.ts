/**
 * 图库文件夹「按漫画导入」（library_roots.content_mode = 'comic'）要一直成立的两条：
 * - 漫画文件夹里没手动改过类型的页都按漫画判（来源 folder、依据「按漫画导入的文件夹」），别的文件夹里没有这样判的页；
 * - 漫画文件夹里没识别过、没手动改过分级的页用文件夹选的分级。
 * 扫描开始后才切换导入方式（扫描按开始时的设置判）、应用内把图移进 / 移出漫画文件夹之后调用一次，把不符合的行改过来。
 */
import type { Db } from '../../db/connection.ts';
import { backfillClassification } from './backfill.ts';
import { COMIC_ROOT_EVIDENCE } from './rules.ts';

/** ids 不传 = 全库检查（一次全表扫描，扫描结束后用）；返回改了的行数 */
export function syncRootModes(db: Db, ids?: number[]): number {
  const scope = ids ? 'AND i.id IN (SELECT value FROM json_each(@ids))' : '';
  const p = { ids: JSON.stringify(ids ?? []), evidence: COMIC_ROOT_EVIDENCE };
  const stale = db
    .prepare(
      `SELECT i.id FROM images i JOIN library_roots r ON r.id = i.root_id
       WHERE i.content_kind_manual = 0 AND (r.content_mode = 'comic') <> (i.content_kind_evidence IS @evidence) ${scope}`,
    )
    .pluck()
    .all(p) as number[];
  if (stale.length) backfillClassification(db, { ids: stale });
  const rated = db
    .prepare(
      `UPDATE images AS i SET rating = r.comic_rating FROM library_roots r
       WHERE r.id = i.root_id AND r.content_mode = 'comic' AND i.tagged_at IS NULL AND i.rating_manual = 0 AND i.rating <> r.comic_rating ${scope}`,
    )
    .run(p).changes;
  return stale.length + rated;
}
