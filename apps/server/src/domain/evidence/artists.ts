/**
 * 识别画师的进度（images.artist_checked_at，证据模块的列）：这张图的画师识别跑过没有。
 * 画师本身（image_artists、artist_manual）是归类的决定，在 domain/curation/artists.ts。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { stmt } from '../tx.ts';

const IN_IDS = 'id IN (SELECT value FROM json_each(?))';

/** 记下画师识别跑过；onlyIfUnchecked 时已经记过的不改时间 */
export function markArtistsChecked(db: Db, u: UndoRecorder | null, ids: number[], at: string, onlyIfUnchecked = false): void {
  if (!ids.length) return;
  u?.columns('images', ['artist_checked_at'], ids);
  stmt(db, `UPDATE images SET artist_checked_at = ${onlyIfUnchecked ? 'COALESCE(artist_checked_at, ?)' : '?'} WHERE ${IN_IDS}`).run(at, JSON.stringify(ids));
}

/** 改回自动画师：清掉进度，「识别画师」会重新认 */
export function clearArtistsChecked(db: Db, u: UndoRecorder | null, ids: number[]): void {
  if (!ids.length) return;
  u?.columns('images', ['artist_checked_at'], ids);
  stmt(db, `UPDATE images SET artist_checked_at = NULL WHERE ${IN_IDS}`).run(JSON.stringify(ids));
}
