/**
 * 角色建议（批量读）：派生视图 v_character_suggestions = 证据里还没关联、也没被否决的候选（迁移 035，附录 #9）。
 * 有对应角色（含合并重定向、规范化）→ 角色名 + 第一个作品名；没有 → catalog.describeTag（中文名、猜测的作品）。
 * Pixiv 给自建角色的建议按 character_id 找角色（danbooru_tag 只是占位）；占位标签没有 character_id 的不显示。
 * 视图只按标签找角色；这里再按角色目录（规范化、核验过的变体）滤掉已经关联、被否决的，同一个角色只留分数最高的一条，每张最多 5 条。
 */
import type { CharacterSuggestion } from '@emaki/shared';
import { NotFoundError } from '../../http/errors.ts';
import { CUSTOM_TAG_PREFIX, type CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import type { SqliteContext } from './context.ts';
import { insertDanbooruCharacter } from './characters.ts';
import type { UndoRecorder } from './undo.ts';
import { toId } from './sql.ts';

export function resolveSuggestedCharacter(ctx: SqliteContext, u: UndoRecorder, catalog: CharacterCatalog, tag: string, now: string): number {
  if (tag.startsWith(CUSTOM_TAG_PREFIX)) throw new NotFoundError('角色建议');
  const existing = catalog.resolveCharacterId(tag);
  if (existing !== null) return existing;
  if (!ctx.stmt(`SELECT 1 FROM v_character_suggestions s JOIN v_counted_images i ON i.id=s.image_id
    WHERE s.danbooru_tag=? AND s.character_id IS NULL LIMIT 1`).get(tag)) throw new NotFoundError('角色建议');
  return insertDanbooruCharacter(u, catalog, tag, { now }).id;
}

/** 每张图最多列几条建议 */
export const MAX_SUGGESTIONS = 5;

export function loadSuggestions(ctx: SqliteContext, imageIds: number[], catalog: CharacterCatalog): Map<number, CharacterSuggestion[]> {
  const out = new Map<number, CharacterSuggestion[]>();
  if (!imageIds.length) return out;
  const rows = ctx
    .stmt(
      `SELECT s.image_id, s.danbooru_tag, s.score, s.source, s.character_id,
         ch.name AS character_name,
         (SELECT w.name FROM character_works cw JOIN works w ON w.id = cw.work_id
           WHERE cw.character_id = s.character_id ORDER BY cw.position LIMIT 1) AS work_name
       FROM v_character_suggestions s
       LEFT JOIN characters ch ON ch.id = s.character_id
       WHERE s.image_id IN (SELECT value FROM json_each(?))
         AND (s.character_id IS NOT NULL OR s.danbooru_tag NOT LIKE '${CUSTOM_TAG_PREFIX}%')
       ORDER BY s.image_id, s.score DESC, s.danbooru_tag`,
    )
    .all(JSON.stringify(imageIds)) as {
    image_id: number;
    danbooru_tag: string;
    score: number;
    source: CharacterSuggestion['source'];
    character_id: number | null;
    character_name: string | null;
    work_name: string | null;
  }[];
  const linked = new Map<number, Set<number>>();
  for (const {image_id, character_id} of ctx.stmt(`SELECT image_id,character_id FROM image_characters
    WHERE image_id IN (SELECT value FROM json_each(?))
    UNION SELECT image_id,character_id FROM character_vetoes WHERE image_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(imageIds), JSON.stringify(imageIds)) as {image_id:number;character_id:number}[]) {
    const set = linked.get(image_id) ?? new Set<number>();
    set.add(character_id);
    linked.set(image_id, set);
  }
  const seen = new Map<number, Set<string>>();
  const described = new Map<string, ReturnType<CharacterCatalog['describeTag']>>();
  for (const r of rows) {
    const list = out.get(r.image_id) ?? [];
    if (list.length >= MAX_SUGGESTIONS) continue;
    const d = r.character_id !== null
      ? { characterId: r.character_id, name: r.character_name!, workName: r.work_name }
      : described.get(r.danbooru_tag) ?? catalog.describeTag(r.danbooru_tag);
    if (r.character_id === null) described.set(r.danbooru_tag, d);
    if (d.characterId !== null && linked.get(r.image_id)?.has(d.characterId)) continue;
    const identity = d.characterId === null ? catalog.normalizeTag(r.danbooru_tag) : `id:${d.characterId}`;
    const keys = seen.get(r.image_id) ?? new Set<string>();
    if (keys.has(identity)) continue;
    keys.add(identity);
    seen.set(r.image_id, keys);
    list.push({
      characterId: d.characterId === null ? null : toId(d.characterId),
      danbooruTag: r.danbooru_tag,
      name: d.name,
      workName: d.workName,
      score: r.score,
      source: r.source,
    });
    out.set(r.image_id, list);
  }
  return out;
}
