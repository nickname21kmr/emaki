/**
 * 图片上的其他归类决定（docs/core-architecture.md 第 2.4 节「归类」）：收藏、手动分级、放下、原创。
 * images 的这几列和「原创」作品的手动关联（image_copyrights 里分数为空的那行）只在这里写。
 * 每个命令写事实、记撤销、声明 curation.*Changed；连带处理（Pixiv 排队、合集、缓存……）由反应做。
 *
 * 还没收进来的（P3b）：Pixiv 自动标的原创（D8，services/pixiv/sync.ts）、手动类型（和自动类型同列，P4 拆开）、
 * 画师（image_artists，和识别画师的进度列混在一起）、手动来源（source_manual，和解析出的来源同列）。
 */
import type { Rating } from '@emaki/shared';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { stmt, type CurationTx } from './links.ts';

const IN_IDS = 'id IN (SELECT value FROM json_each(?))';

export function setFavorite(tx: CurationTx, u: UndoRecorder | null, ids: number[], value: boolean): void {
  if (!ids.length) return;
  u?.columns('images', ['favorite'], ids);
  stmt(tx.db, `UPDATE images SET favorite = ? WHERE ${IN_IDS}`).run(value ? 1 : 0, JSON.stringify(ids));
  tx.changed({ type: 'curation.favoriteChanged', ids });
}

/** 手动分级：记 rating_manual，之后识别不再覆盖 */
export function setRating(tx: CurationTx, u: UndoRecorder | null, ids: number[], rating: Rating): void {
  if (!ids.length) return;
  u?.columns('images', ['rating', 'rating_manual'], ids);
  stmt(tx.db, `UPDATE images SET rating = ?, rating_manual = 1 WHERE ${IN_IDS}`).run(rating, JSON.stringify(ids));
  tx.changed({ type: 'curation.ratingChanged', ids });
}

/** 放下（at 是时间）/ 放回（null） */
export function setShelved(tx: CurationTx, u: UndoRecorder | null, ids: number[], at: string | null): void {
  if (!ids.length) return;
  u?.columns('images', ['shelved_at'], ids);
  stmt(tx.db, `UPDATE images SET shelved_at = ? WHERE ${IN_IDS}`).run(at, JSON.stringify(ids));
  tx.changed({ type: 'curation.shelvedChanged', ids });
}

/**
 * 归为原创（at 是时间）/ 移出原创（null）。「原创」作品的手动关联（分数为空）一起挂上 / 去掉：不然图算原创，原创作品页里却没有它；
 * 识别器认出的那行（分数不为空）不动。workId 是「原创」作品（编目模块负责有没有、建不建）；还没有这部作品时为 null，只改标记
 */
export function setOriginal(tx: CurationTx, u: UndoRecorder | null, ids: number[], at: string | null, workId: number | null): void {
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  u?.columns('images', ['original_at'], ids);
  if (workId !== null) u?.set('image_copyrights', 'work_id = ? AND image_id IN (SELECT value FROM json_each(?))', [workId, json]);
  stmt(tx.db, `UPDATE images SET original_at = ? WHERE ${IN_IDS}`).run(at, json);
  if (workId !== null && at !== null) {
    stmt(tx.db, 'INSERT OR IGNORE INTO image_copyrights (image_id, work_id, score) SELECT value, ?, NULL FROM json_each(?)').run(workId, json);
  } else if (workId !== null) {
    stmt(tx.db, 'DELETE FROM image_copyrights WHERE work_id = ? AND score IS NULL AND image_id IN (SELECT value FROM json_each(?))').run(workId, json);
  }
  tx.changed({ type: 'curation.originalChanged', ids });
}

/**
 * 查重合并（附录 #12）：副本上的收藏、原创、手动分级、放下并到保留的图上。保留的图自己已有的不动：
 * 收藏只加不减；原创、放下取副本里最早的时间（保留的图没有时）；分级取副本里手动改过的最严的（保留的图没手动改过时）。
 * originalWorkId：「原创」作品，还没有就是 null。返回改了的图（按决定分）
 */
export function carryMarks(
  tx: CurationTx,
  u: UndoRecorder | null,
  keep: number[],
  gone: number[],
  originalWorkId: number | null,
): { favorite: number[]; original: number[]; rating: number[]; shelved: number[] } {
  const out = { favorite: [] as number[], original: [] as number[], rating: [] as number[], shelved: [] as number[] };
  if (!keep.length || !gone.length) return out;
  const db = tx.db;
  const g = JSON.stringify(gone);
  const d = stmt(
    db,
    `SELECT MAX(favorite) AS favorite, MIN(original_at) AS original_at, MIN(shelved_at) AS shelved_at,
       (SELECT rating FROM images WHERE id IN (SELECT value FROM json_each(@g)) AND rating_manual = 1
         ORDER BY CASE rating WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2 WHEN 'sensitive' THEN 1 ELSE 0 END DESC LIMIT 1) AS rating
     FROM images WHERE id IN (SELECT value FROM json_each(@g))`,
  ).get({ g }) as { favorite: number | null; original_at: string | null; shelved_at: string | null; rating: Rating | null };
  const k = stmt(db, 'SELECT id, favorite, original_at, shelved_at, rating_manual FROM images WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL').all(
    JSON.stringify(keep),
  ) as { id: number; favorite: number; original_at: string | null; shelved_at: string | null; rating_manual: number }[];
  if (d.favorite) {
    out.favorite = k.filter((r) => !r.favorite).map((r) => r.id);
    setFavorite(tx, u, out.favorite, true);
  }
  if (d.original_at) {
    out.original = k.filter((r) => r.original_at === null).map((r) => r.id);
    setOriginal(tx, u, out.original, d.original_at, originalWorkId);
  }
  if (d.rating) {
    out.rating = k.filter((r) => !r.rating_manual).map((r) => r.id);
    setRating(tx, u, out.rating, d.rating);
  }
  if (d.shelved_at) {
    out.shelved = k.filter((r) => r.shelved_at === null).map((r) => r.id);
    setShelved(tx, u, out.shelved, d.shelved_at);
  }
  return out;
}
