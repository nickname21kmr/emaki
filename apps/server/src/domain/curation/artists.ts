/**
 * 图 ↔ 画师（image_artists、images.artist_manual）的唯一写入者（docs/core-architecture.md 第 2.4 节「归类」，P3b）。
 * - 识别出的画师（PixAI 的画师输出）是自动的：手动改过画师的图不动；
 * - 用户手动改的记 artist_manual，之后识别、补跑都不再动它；改回自动时清掉，「识别画师」会重新认。
 * 画师识别跑没跑过（artist_checked_at）是证据模块的进度列，经 domain/evidence/artists.ts 写。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { clearArtistsChecked, markArtistsChecked } from '../evidence/artists.ts';
import { stmt, type DomainTx } from '../tx.ts';

const IN_IDS = 'image_id IN (SELECT value FROM json_each(?))';

/** 识别出的画师替换旧的（自动）；手动改过画师的图不动，返回改了没有。识别写入在自己的事务里调用 */
export function setAutoArtists(db: Db, imageId: number, artists: [string, number][]): boolean {
  if (stmt(db, 'SELECT artist_manual FROM images WHERE id = ?').pluck().get(imageId)) return false;
  stmt(db, 'DELETE FROM image_artists WHERE image_id = ?').run(imageId);
  const ins = stmt(db, 'INSERT INTO image_artists (image_id, artist, score) VALUES (?, ?, ?)');
  for (const [a, s] of artists) ins.run(imageId, a, s);
  return true;
}

/**
 * 手动改画师：set 整组替换、add 追加、remove 去掉（allTags 是要去掉的全部标签，含同一个人的别的写法）。
 * 改过的图记 artist_manual，进度记成跑过（之后识别不再动它）
 */
export function setManualArtists(
  tx: DomainTx,
  u: UndoRecorder | null,
  ids: number[],
  mode: 'set' | 'add' | 'remove',
  tags: string[],
  now: string,
): void {
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  const db = tx.db;
  u?.set('image_artists', IN_IDS, [json]);
  u?.columns('images', ['artist_manual'], ids);
  if (mode === 'set') stmt(db, `DELETE FROM image_artists WHERE ${IN_IDS}`).run(json);
  if (mode === 'remove') stmt(db, `DELETE FROM image_artists WHERE ${IN_IDS} AND artist IN (SELECT value FROM json_each(?))`).run(json, JSON.stringify(tags));
  else stmt(db, 'INSERT OR IGNORE INTO image_artists (image_id, artist, score) SELECT i.value, t.value, 1 FROM json_each(?) i, json_each(?) t').run(json, JSON.stringify(tags));
  stmt(db, 'UPDATE images SET artist_manual = 1 WHERE id IN (SELECT value FROM json_each(?))').run(json);
  markArtistsChecked(db, u, ids, now, true);
  tx.changed({ type: 'curation.artistsChanged', ids });
}

/** 改回自动画师：只动手动改过的图，清掉手动改的画师和进度（「识别画师」会重新认）。返回动了的图 */
export function resetArtists(tx: DomainTx, u: UndoRecorder | null, ids: number[]): number[] {
  const db = tx.db;
  const edited = stmt(db, 'SELECT id FROM images WHERE artist_manual = 1 AND id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(ids)) as number[];
  if (edited.length) {
    const mj = JSON.stringify(edited);
    u?.set('image_artists', IN_IDS, [mj]);
    u?.columns('images', ['artist_manual'], edited);
    stmt(db, `DELETE FROM image_artists WHERE ${IN_IDS}`).run(mj);
    stmt(db, 'UPDATE images SET artist_manual = 0 WHERE id IN (SELECT value FROM json_each(?))').run(mj);
    clearArtistsChecked(db, u, edited);
  }
  // 改回自动的由反应排「识别画师」（撤销手动改画师时也一样，附录 #22）
  tx.changed({ type: 'curation.artistsChanged', ids: edited });
  return edited;
}

/**
 * 查重合并（附录 #12）：副本里第一张手动改过画师的，整组照搬到保留的图上（保留的图自己手动改过的不动）。
 * 撤销快照由调用方记（u.set image_artists 的范围比这里大）。返回改了的图
 */
export function carryArtists(tx: DomainTx, u: UndoRecorder | null, keep: number[], gone: number[], now: string): number[] {
  const db = tx.db;
  const src = stmt(db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND artist_manual = 1 ORDER BY id LIMIT 1').pluck().get(JSON.stringify(gone)) as
    | number
    | undefined;
  if (src === undefined) return [];
  const targets = stmt(db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL AND artist_manual = 0').pluck().all(
    JSON.stringify(keep),
  ) as number[];
  if (!targets.length) return [];
  u?.set('image_artists', IN_IDS, [JSON.stringify(targets)]);
  u?.columns('images', ['artist_manual'], targets);
  for (const t of targets) {
    stmt(db, 'DELETE FROM image_artists WHERE image_id = ?').run(t);
    stmt(db, 'INSERT INTO image_artists (image_id, artist, score) SELECT ?, artist, score FROM image_artists WHERE image_id = ?').run(t, src);
  }
  stmt(db, 'UPDATE images SET artist_manual = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(targets));
  markArtistsChecked(db, u, targets, now, true);
  return targets;
}
