/**
 * 图片上的其他归类决定（docs/core-architecture.md 第 2.4 节「归类」）：收藏、分级、放下、原创（带来历，D8）。
 * images 的这几列只在 domain/curation/ 里写。每个命令写事实、记撤销、声明 curation.*Changed；
 * 连带处理（Pixiv 排队、合集、自动决定的重新评估、缓存……）由反应做。
 * 画师、手动来源、手动类型的标记在 artists.ts、source.ts、kinds.ts。
 */
import type { Rating } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import { currentActor } from '../../propagation/actor.ts';
import { COMIC_RATING, IN_COMIC } from '../../services/classify/comicAreas.ts';
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

/** 识别模型给的分级（自动）：手动改过分级的图不动。识别写入在自己的事务里调用 */
export function setAutoRating(db: Db, imageId: number, rating: Rating): void {
  stmt(db, 'UPDATE images SET rating = ? WHERE id = ? AND rating_manual = 0').run(rating, imageId);
}

/** 按快照放回自动分级（撤销切换按漫画导入时）：手动改过分级的图不动 */
export function restoreAutoRatings(db: Db, rows: { id: number; rating: Rating }[]): void {
  const upd = stmt(db, 'UPDATE images SET rating = ? WHERE id = ? AND rating_manual = 0');
  for (const r of rows) upd.run(r.rating, r.id);
}

/**
 * 按漫画导入的范围里、没识别过、没手动改过分级的页用范围选的分级（自动分级）。ids 不给 = 全库。返回改了的行数
 */
export function rateComicPages(db: Db, ids?: number[]): number {
  const scope = ids ? 'AND i.id IN (SELECT value FROM json_each(@ids))' : '';
  return stmt(
    db,
    `UPDATE images AS i SET rating = ${COMIC_RATING('i')}
     WHERE i.tagged_at IS NULL AND i.rating_manual = 0 AND ${IN_COMIC('i')} AND i.rating <> ${COMIC_RATING('i')} ${scope}`,
  ).run({ ids: JSON.stringify(ids ?? []) }).changes;
}

/** 放下（at 是时间）/ 放回（null） */
export function setShelved(tx: CurationTx, u: UndoRecorder | null, ids: number[], at: string | null): void {
  if (!ids.length) return;
  u?.columns('images', ['shelved_at'], ids);
  stmt(tx.db, `UPDATE images SET shelved_at = ? WHERE ${IN_IDS}`).run(at, JSON.stringify(ids));
  tx.changed({ type: 'curation.shelvedChanged', ids });
}

/** 原创的来历列（迁移 035）：撤销时一起还原（撤销快照里写成字面量，单一写入者测试才看得出列） */
export const ORIGINAL_COLS = ['original_at', 'original_decision', 'original_actor', 'original_rule', 'original_evidence_provider'];

/**
 * 手动归为原创（at 是时间）/ 手动移出原创（null）：都是用户的决定（D8），之后自动规则不再改它——
 * 用户取消过的，Pixiv 的原创信号也不会再把它标回来。图算不算「原创」作品由 original_at 派生（v_image_works），
 * 「原创」作品有没有、建不建是编目模块的事（domain/catalog/original.ts 的 ensureOriginalWork）
 */
export function setOriginal(tx: CurationTx, u: UndoRecorder | null, ids: number[], at: string | null, actor: string = currentActor()): void {
  if (!ids.length) return;
  u?.columns('images', ['original_at', 'original_decision', 'original_actor', 'original_rule', 'original_evidence_provider'], ids);
  stmt(
    tx.db,
    `UPDATE images SET original_at = ?, original_decision = 'manual', original_actor = ?, original_rule = NULL, original_evidence_provider = NULL
     WHERE ${IN_IDS}`,
  ).run(at, actor, JSON.stringify(ids));
  tx.changed({ type: 'curation.originalChanged', ids });
}

/**
 * 自动规则（decideAuto）标原创 / 撤回自动标的原创。只动没有手动决定的图；
 * 声明 curation.autoOriginalChanged（reevaluateAuto 不订阅它，见 propagation/changes.ts）
 */
export function setAutoOriginal(
  tx: CurationTx,
  u: UndoRecorder | null,
  items: { imageId: number; provider: string; rule: string }[],
  at: string,
  actor: string = currentActor(),
): number[] {
  if (!items.length) return [];
  const ids = items.map((x) => x.imageId);
  u?.columns('images', ['original_at', 'original_decision', 'original_actor', 'original_rule', 'original_evidence_provider'], ids);
  const changed = stmt(
    tx.db,
    `UPDATE images SET original_at = @at, original_decision = 'auto', original_actor = @actor, original_rule = j.value ->> 1, original_evidence_provider = j.value ->> 2
     FROM json_each(@items) j WHERE images.id = j.value ->> 0 AND images.original_at IS NULL AND images.original_decision IS NOT 'manual'
     RETURNING images.id`,
  )
    .pluck()
    .all({ at, actor, items: JSON.stringify(items.map((x) => [x.imageId, x.rule, x.provider])) }) as number[];
  tx.changed({ type: 'curation.autoOriginalChanged', ids: changed });
  return changed;
}

/** 撤回自动标的原创（证据里的原创信号不在了，D2 / D8）；返回撤回前的样子（记审计用） */
export function clearAutoOriginal(tx: CurationTx, u: UndoRecorder | null, ids: number[]): OriginalRow[] {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const rows = stmt(
    tx.db,
    `SELECT id, ${ORIGINAL_COLS.join(', ')} FROM images WHERE ${IN_IDS} AND original_decision = 'auto' AND original_at IS NOT NULL`,
  ).all(json) as OriginalRow[];
  if (!rows.length) return [];
  const hit = rows.map((r) => r.id);
  u?.columns('images', ['original_at', 'original_decision', 'original_actor', 'original_rule', 'original_evidence_provider'], hit);
  stmt(
    tx.db,
    `UPDATE images SET original_at = NULL, original_decision = NULL, original_actor = NULL, original_rule = NULL, original_evidence_provider = NULL
     WHERE ${IN_IDS}`,
  ).run(JSON.stringify(hit));
  tx.changed({ type: 'curation.autoOriginalChanged', ids: hit });
  return rows;
}

/** images 上原创的来历 */
export interface OriginalRow {
  id: number;
  original_at: string | null;
  original_decision: 'manual' | 'auto' | null;
  original_actor: string | null;
  original_rule: string | null;
  original_evidence_provider: string | null;
}

/**
 * 按记下的来历放回原创标记（撤回「撤回」时用）：只放回现在没标原创、也没有新的手动决定的图；
 * manual 为真时放回成手动（用户撤回了自动的撤回 = 用户认可）。返回放回的图
 */
export function restoreOriginals(tx: CurationTx, u: UndoRecorder | null, rows: OriginalRow[], actor: string = currentActor()): number[] {
  if (!rows.length) return [];
  const free = new Set(
    stmt(tx.db, `SELECT id FROM images WHERE ${IN_IDS} AND original_at IS NULL AND original_decision IS NULL`)
      .pluck()
      .all(JSON.stringify(rows.map((r) => r.id))) as number[],
  );
  const todo = rows.filter((r) => free.has(r.id) && r.original_at);
  if (!todo.length) return [];
  const ids = todo.map((r) => r.id);
  u?.columns('images', ['original_at', 'original_decision', 'original_actor', 'original_rule', 'original_evidence_provider'], ids);
  const upd = stmt(
    tx.db,
    `UPDATE images SET original_at = ?, original_decision = 'manual', original_actor = ?, original_rule = NULL, original_evidence_provider = NULL WHERE id = ?`,
  );
  for (const r of todo) upd.run(r.original_at, actor, r.id);
  tx.changed({ type: 'curation.originalChanged', ids });
  return ids;
}

/**
 * 查重合并（附录 #12）：副本上的收藏、原创、手动分级、放下并到保留的图上。保留的图自己已有的不动：
 * 收藏只加不减；原创、放下取副本里最早的时间（保留的图没有时，原创搬成手动的决定）；分级取副本里手动改过的最严的（保留的图没手动改过时）。
 * 返回改了的图（按决定分）
 */
export function carryMarks(
  tx: CurationTx,
  u: UndoRecorder | null,
  keep: number[],
  gone: number[],
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
    setOriginal(tx, u, out.original, d.original_at);
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
