/**
 * 「自建角色能对上 Danbooru」匹配器：纯本地、同步。T13 getStats（customMatchableCount）、T14 编辑后重算。
 * 只做精确 key 匹配，不做子串；再用作品校验加减分。
 */
import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { DanbooruCatalog } from './catalog.ts';
import { resolveCharacterIdByTag } from '../catalog/characterCatalog.ts';

export interface DanbooruMatch {
  danbooruTag: string;
  score: number;
  postCount: number;
  reason: string;
  existingCharacterId: number | null;
  nameKind?: string;
  workMatch?: 'same' | 'different' | 'unknown';
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
         AND COALESCE(NULLIF(d.category, -1), i.category) = 4 AND COALESCE(d.not_found, 0) = 0`,
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

  return [...best].map(([tag, b]) => {
    let score = b.score;
    let workMatch: DanbooruMatch['workMatch'] = 'unknown';
    let reason = `${b.kind}:${ch.name}`;
    if (W.size) {
      const C = new Set(danbooru.copyrights(tag).flatMap((c) => [c, ...danbooru.impliesClosure(c)]));
      const hit = [...C].find((c) => W.has(c));
      if (hit) {
        workMatch = 'same';
        score += 0.3;
        reason += ` + work:${hit}`;
      } else if (C.size) {
        workMatch = 'different';
        score -= 0.5;
        reason += ' - work 不符';
      }
    }
    return { danbooruTag: tag, score, postCount: b.postCount, reason, existingCharacterId: resolveCharacterIdByTag(db, tag, (t) => danbooru.normalizeTag(t)), nameKind: b.kind, workMatch };
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
  const upsert = db.prepare(`INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, computed_at, dismissed)
    VALUES (?, ?, ?, ?, (SELECT id FROM characters WHERE danbooru_tag = ?), ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET danbooru_tag = excluded.danbooru_tag, score = excluded.score, reason = excluded.reason,
      existing_character_id = excluded.existing_character_id, computed_at = excluded.computed_at,
      dismissed = excluded.dismissed`);
  const previous = db.prepare('SELECT danbooru_tag, dismissed FROM custom_character_matches WHERE character_id = ?');
  const del = db.prepare('DELETE FROM custom_character_matches WHERE character_id = ?');
  const isCustom = db.prepare("SELECT 1 FROM characters WHERE id = ? AND source = 'custom' AND danbooru_tag IS NULL").pluck();
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of ids) {
      const m = isCustom.get(id) ? decideMatch(findDanbooruMatches(db, danbooru, id)) : null;
      if (m) {
        const prev = previous.get(id) as { danbooru_tag: string; dismissed: number } | undefined;
        const dismissed = prev?.dismissed && danbooru.normalizeTag(prev.danbooru_tag) === danbooru.normalizeTag(m.danbooruTag) ? 1 : 0;
        upsert.run(id, m.danbooruTag, m.score, m.reason, m.danbooruTag, now, dismissed);
      }
      else del.run(id);
    }
  })();
}

/** 自动绑定不采用建议分差或投稿量：去掉作品冲突、合并服装变体后，必须只剩一个身份。 */
export function decideAutomaticMatch(cands: DanbooruMatch[], normalize: (tag: string) => string): DanbooruMatch | null {
  const compatible = cands.filter((c) => c.workMatch !== 'different');
  const identities = new Set(compatible.map((c) => normalize(c.danbooruTag)));
  if (identities.size !== 1) return null;
  const exact = compatible.find((c) => c.nameKind === 'zh' || c.nameKind === 'other_name' || c.workMatch === 'same');
  return exact ? { ...exact, danbooruTag: normalize(exact.danbooruTag) } : null;
}

/** 先为所有自建角色做只读计划，避免先处理的角色抢走其他同名自建角色的标签。 */
export function automaticCustomMatches(db: Db, danbooru: DanbooruCatalog): { id: number; match: DanbooruMatch }[] {
  const customs = db.prepare("SELECT id FROM characters WHERE source = 'custom' AND danbooru_tag IS NULL").all() as { id: number }[];
  const dismissed = db.prepare('SELECT danbooru_tag FROM custom_character_matches WHERE character_id = ? AND dismissed = 1').pluck();
  const candidates = customs.map(({ id }) => ({ id, matches: findDanbooruMatches(db, danbooru, id) }));
  const claimants = new Map<string, Set<number>>();
  for (const { id, matches } of candidates) {
    for (const m of matches.filter((m) => m.workMatch !== 'different')) {
      const tag = danbooru.normalizeTag(m.danbooruTag);
      if (!claimants.has(tag)) claimants.set(tag, new Set());
      claimants.get(tag)!.add(id);
    }
  }
  return candidates.flatMap(({ id, matches }) => {
    const match = decideAutomaticMatch(matches, (t) => danbooru.normalizeTag(t));
    if (!match || claimants.get(match.danbooruTag)!.size !== 1) return [];
    const ignoredTag = dismissed.get(id) as string | undefined;
    if (ignoredTag && danbooru.normalizeTag(ignoredTag) === match.danbooruTag) return [];
    if (resolveCharacterIdByTag(db, match.danbooruTag) !== null) return [];
    return [{ id, match }];
  });
}
