/**
 * 角色建议（character_suggestions，证据模块的表）的清理：给归类模块调用。
 * 建议改成派生视图（第 2.3 节）是 P3b 的事；在那之前，关联了某个角色之后由这里去掉同一张图上指向它的建议，
 * 读的时候（suggestions.ts）还会再滤掉一次已经关联的。
 */
import type { Db, Statement } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';

const cache = new WeakMap<Db, Map<string, Statement>>();
const stmt = (db: Db, sql: string): Statement => {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
};

/**
 * 去掉这些「图 + 角色」对应的建议：建议的 character_id 就是这个角色（Pixiv 给自建角色的），
 * 或者标签是这个角色的 Danbooru 标签、指向它的合并重定向、证据里的那个标签（tag）。返回去掉的条数
 */
export function dropSuggestionsForLinks(db: Db, u: UndoRecorder | null, pairs: { imageId: number; characterId: number; tag?: string | null }[]): number {
  if (!pairs.length) return 0;
  const rows = stmt(
    db,
    `SELECT DISTINCT s.image_id, s.danbooru_tag FROM json_each(?) j
     JOIN character_suggestions s ON s.image_id = j.value ->> 0
     WHERE s.character_id = j.value ->> 1 OR s.danbooru_tag = j.value ->> 2
        OR s.danbooru_tag = (SELECT c.danbooru_tag FROM characters c WHERE c.id = j.value ->> 1)
        OR s.danbooru_tag IN (SELECT r.tag FROM danbooru_tag_redirects r WHERE r.character_id = j.value ->> 1)`,
  ).all(JSON.stringify(pairs.map((p) => [p.imageId, p.characterId, p.tag ?? null]))) as { image_id: number; danbooru_tag: string }[];
  return dropSuggestions(db, u, rows.map((r) => ({ imageId: r.image_id, tag: r.danbooru_tag })));
}

/** 去掉这些建议（图 + 标签）；撤销时放回。返回去掉的条数 */
export function dropSuggestions(db: Db, u: UndoRecorder | null, rows: { imageId: number; tag: string }[]): number {
  if (!rows.length) return 0;
  const json = JSON.stringify(rows.map((r) => [r.imageId, r.tag]));
  const where = '(image_id, danbooru_tag) IN (SELECT value ->> 0, value ->> 1 FROM json_each(?))';
  u?.set('character_suggestions', where, [json]);
  return stmt(db, `DELETE FROM character_suggestions WHERE ${where}`).run(json).changes;
}
