/**
 * tagger 给出的、还没被采纳的角色建议（批量）。
 * 有对应角色（含合并重定向）→ 角色名 + 第一个作品名；没有 → catalog.describeTag（中文名、猜测的作品）。
 */
import type { CharacterSuggestion } from '@emaki/shared';
import type { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import type { SqliteContext } from './context.ts';
import { toId } from './sql.ts';

export function loadSuggestions(ctx: SqliteContext, imageIds: number[], catalog: CharacterCatalog): Map<number, CharacterSuggestion[]> {
  const out = new Map<number, CharacterSuggestion[]>();
  if (!imageIds.length) return out;
  const rows = ctx
    .stmt(
      `SELECT s.image_id, s.danbooru_tag, s.score, COALESCE(c.id, r.character_id) AS character_id,
         ch.name AS character_name,
         (SELECT w.name FROM character_works cw JOIN works w ON w.id = cw.work_id
           WHERE cw.character_id = COALESCE(c.id, r.character_id) ORDER BY cw.position LIMIT 1) AS work_name
       FROM character_suggestions s
       LEFT JOIN characters c ON c.danbooru_tag = s.danbooru_tag
       LEFT JOIN danbooru_tag_redirects r ON r.tag = s.danbooru_tag
       LEFT JOIN characters ch ON ch.id = COALESCE(c.id, r.character_id)
       WHERE s.image_id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM image_characters ic
                         WHERE ic.image_id = s.image_id AND ic.character_id = COALESCE(c.id, r.character_id))
       ORDER BY s.image_id, s.score DESC, s.danbooru_tag`,
    )
    .all(JSON.stringify(imageIds)) as {
    image_id: number;
    danbooru_tag: string;
    score: number;
    character_id: number | null;
    character_name: string | null;
    work_name: string | null;
  }[];
  for (const r of rows) {
    const list = out.get(r.image_id) ?? [];
    if (r.character_id !== null) {
      list.push({ characterId: toId(r.character_id), danbooruTag: r.danbooru_tag, name: r.character_name!, workName: r.work_name, score: r.score });
    } else {
      const d = catalog.describeTag(r.danbooru_tag);
      list.push({
        characterId: d.characterId === null ? null : toId(d.characterId),
        danbooruTag: r.danbooru_tag,
        name: d.name,
        workName: d.workName,
        score: r.score,
      });
    }
    out.set(r.image_id, list);
  }
  return out;
}
