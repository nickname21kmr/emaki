/**
 * 图库文件夹「按漫画导入」（library_roots.content_mode = 'comic'）要一直成立的几条：
 * - 漫画文件夹里没手动改过类型的页都按漫画判（来源 folder、依据「按漫画导入的文件夹」），别的文件夹里没有这样判的页；
 * - 漫画文件夹里没识别过、没手动改过分级的页用文件夹选的分级；
 * - 漫画文件夹里的页不挂识别器认出的角色（改成漫画之前识别过的页会带着一堆误认的角色，手动加的留着）。
 *   清掉角色的页同时标成要重新识别：在漫画文件夹里识别任务不领它，离开之后（改回插画、移出去、磁盘上挪走）就会重新认。
 * 扫描开始后才切换导入方式（扫描按开始时的设置判）、应用内把图移进 / 移出漫画文件夹之后调用一次，把不符合的行改过来。
 * 能撤销的调用方先用 recordRootModeUndo 记下会动的行。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { backfillClassification } from './backfill.ts';
import { COMIC_RATING, IN_COMIC } from './comicAreas.ts';
import { COMIC_ROOT_EVIDENCE } from './rules.ts';

/** ids 不传 = 全库检查（一次全表扫描，扫描结束后用）；返回改了的行数 */
export function syncRootModes(db: Db, ids?: number[]): number {
  const scope = ids ? 'AND i.id IN (SELECT value FROM json_each(@ids))' : '';
  const p = { ids: JSON.stringify(ids ?? []), evidence: COMIC_ROOT_EVIDENCE };
  const stale = db
    .prepare(`SELECT i.id FROM images i WHERE i.content_kind_manual = 0 AND (${IN_COMIC('i')}) <> (i.content_kind_evidence IS @evidence) ${scope}`)
    .pluck()
    .all(p) as number[];
  if (stale.length) backfillClassification(db, { ids: stale });
  const rated = db
    .prepare(
      `UPDATE images AS i SET rating = ${COMIC_RATING('i')}
       WHERE i.tagged_at IS NULL AND i.rating_manual = 0 AND ${IN_COMIC('i')} AND i.rating <> ${COMIC_RATING('i')} ${scope}`,
    )
    .run(p).changes;
  // 要清角色的页先标重新识别（只标真被清掉的，本来就没认出角色的不用重跑）
  const retagged = db
    .prepare(
      `UPDATE images AS i SET retag = 1
       WHERE i.retag = 0 AND ${IN_COMIC('i')} ${scope}
         AND EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.origin = 'tagger')`,
    )
    .run(p).changes;
  const unlinked = db
    .prepare(`DELETE FROM image_characters WHERE origin = 'tagger' AND image_id IN (SELECT i.id FROM images i WHERE ${IN_COMIC('i')} ${scope})`)
    .run(p).changes;
  return retagged + stale.length + rated + unlinked;
}

/** 撤销用：syncRootModes 会动的识别器角色和重新识别标记，在调用之前记下（ids 是之后要同步的图） */
export function recordRootModeUndo(u: UndoRecorder, ids: number[]): void {
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  u.set('image_characters', "origin = 'tagger' AND image_id IN (SELECT value FROM json_each(?))", [json]);
  u.columns('images', ['retag'], ids);
}
