/**
 * 「自建角色能对上 Danbooru」匹配器：纯本地、同步。T13 getStats（customMatchableCount）、T14 编辑后重算。
 * 只做精确 key 匹配，不做子串；再用作品校验加减分。
 */
import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { DanbooruCatalog } from './catalog.ts';

export interface DanbooruMatch {
  danbooruTag: string;
  score: number;
  postCount: number;
  reason: string;
  existingCharacterId: number | null;
}

const KIND_SCORE: Record<string, number> = { zh: 1.0, other_name: 0.9, alias: 0.8, tag: 0.7 };

/** 纯 ASCII 的 key 长度 < 3、其他 < 2 的丢掉（防止「ba」「未」这类误配） */
const usableKey = (k: string) => (/^[\x00-\x7f]*$/.test(k) ? k.length >= 3 : k.length >= 2);

export function findDanbooruMatches(db: Db, danbooru: DanbooruCatalog, characterId: number): DanbooruMatch[] {
  const ch = db.prepare('SELECT name FROM characters WHERE id = ?').get(characterId) as { name: string } | undefined;
  if (!ch) return [];
  const aliases = db.prepare("SELECT alias FROM aliases WHERE owner_type = 'character' AND owner_id = ?").pluck().all(characterId) as string[];
  const keys = [...new Set([ch.name, ...aliases].map(searchKey))].filter(usableKey);
  if (!keys.length) return [];

  const rows = db
    .prepare(
      `SELECT k.tag, k.kind, COALESCE(d.post_count, i.post_count, 0) AS post_count
       FROM tag_name_keys k
       LEFT JOIN tag_i18n i ON i.tag = k.tag
       LEFT JOIN danbooru_tags d ON d.name = k.tag
       WHERE k.search_key IN (SELECT value FROM json_each(?))
         AND COALESCE(NULLIF(d.category, -1), i.category) = 4`,
    )
    .all(JSON.stringify(keys)) as { tag: string; kind: string; post_count: number }[];

  const best = new Map<string, { score: number; kind: string; postCount: number }>();
  for (const r of rows) {
    const tag = danbooru.canonicalize(r.tag);
    const s = KIND_SCORE[r.kind] ?? 0.7;
    const prev = best.get(tag);
    if (!prev || s > prev.score) best.set(tag, { score: s, kind: r.kind, postCount: Math.max(r.post_count, prev?.postCount ?? 0) });
  }

  // 作品校验：自建角色所属作品（及其上层系列）与候选的作品是否相交
  const workTags = db
    .prepare('SELECT w.danbooru_tag FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = ? AND w.danbooru_tag IS NOT NULL')
    .pluck()
    .all(characterId) as string[];
  const W = new Set(workTags.flatMap((w) => [w, ...danbooru.impliesClosure(w)]));
  const existing = db.prepare('SELECT id FROM characters WHERE danbooru_tag = ?').pluck();

  return [...best].map(([tag, b]) => {
    let score = b.score;
    let reason = `${b.kind}:${ch.name}`;
    if (W.size) {
      const C = new Set(danbooru.copyrights(tag).flatMap((c) => [c, ...danbooru.impliesClosure(c)]));
      const hit = [...C].find((c) => W.has(c));
      if (hit) {
        score += 0.3;
        reason += ` + work:${hit}`;
      } else if (C.size) {
        score -= 0.5;
        reason += ' - work 不符';
      }
    }
    return { danbooruTag: tag, score, postCount: b.postCount, reason, existingCharacterId: (existing.get(tag) as number | undefined) ?? null };
  });
}

/** 最高分 ≥ 0.9，且（没有第二名 或 分差 ≥ 0.2 或 post_count ≥ 第二名 3 倍）才算匹配 */
export function decideMatch(cands: DanbooruMatch[]): DanbooruMatch | null {
  const sorted = [...cands].sort((a, b) => b.score - a.score || b.postCount - a.postCount);
  const [top, second] = sorted;
  if (!top || top.score < 0.9) return null;
  if (!second || top.score - second.score >= 0.2 || top.postCount >= second.postCount * 3) return top;
  return null;
}

export function recomputeCustomMatches(db: Db, danbooru: DanbooruCatalog, characterIds?: number[]): void {
  const ids =
    characterIds ??
    (db.prepare("SELECT id FROM characters WHERE source = 'custom' AND danbooru_tag IS NULL").pluck().all() as number[]);
  const upsert = db.prepare(`INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, computed_at)
    VALUES (?, ?, ?, ?, (SELECT id FROM characters WHERE danbooru_tag = ?), ?)
    ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, score = excluded.score, reason = excluded.reason,
      existing_character_id = excluded.existing_character_id, computed_at = excluded.computed_at,
      dismissed = CASE WHEN custom_character_matches.danbooru_tag = excluded.danbooru_tag THEN custom_character_matches.dismissed ELSE 0 END`);
  const del = db.prepare('DELETE FROM custom_character_matches WHERE character_id = ?');
  const isCustom = db.prepare("SELECT 1 FROM characters WHERE id = ? AND source = 'custom' AND danbooru_tag IS NULL").pluck();
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of ids) {
      const m = isCustom.get(id) ? decideMatch(findDanbooruMatches(db, danbooru, id)) : null;
      if (m) upsert.run(id, m.danbooruTag, m.score, m.reason, m.danbooruTag, now);
      else del.run(id);
    }
  })();
}
