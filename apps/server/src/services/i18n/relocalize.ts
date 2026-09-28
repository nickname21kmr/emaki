/**
 * 全库重算显示名和自动别名（词库导入后、Danbooru 同步后）。调用方负责包事务。
 * 用户改过的名字（name_locked = 1）不动。
 */
import type { Db } from '../../db/connection.ts';
import { replaceAutoAliases } from '../aliases.ts';
import { humanizeCharacterTag } from './humanize.ts';
import type { Localizer } from './localizer.ts';

export function relocalizeAll(db: Db, localizer: Localizer): { renamed: number } {
  let renamed = 0;
  const setChar = db.prepare('UPDATE characters SET name = ? WHERE id = ? AND name <> ?');
  const setWork = db.prepare('UPDATE works SET name = ? WHERE id = ? AND name <> ?');

  const chars = db
    .prepare("SELECT id, danbooru_tag AS tag FROM characters WHERE source = 'danbooru' AND danbooru_tag IS NOT NULL AND name_locked = 0")
    .all() as { id: number; tag: string }[];
  for (const c of chars) renamed += setChar.run(localizer.characterName(c.tag).name, c.id, localizer.characterName(c.tag).name).changes;

  const works = db.prepare('SELECT id, danbooru_tag AS tag FROM works WHERE danbooru_tag IS NOT NULL AND name_locked = 0').all() as {
    id: number;
    tag: string;
  }[];
  for (const w of works) renamed += setWork.run(localizer.workName(w.tag).name, w.id, localizer.workName(w.tag).name).changes;

  // 同名消歧：词库里 saber_(fate) 和 artoria_pendragon_(fate) 都叫「阿尔托莉雅·潘德拉贡」，张数最多的保留原名
  const dupes = db
    .prepare(
      `SELECT c.id, c.name, c.danbooru_tag AS tag,
         COALESCE((SELECT post_count FROM danbooru_tags d WHERE d.name = c.danbooru_tag),
                  (SELECT post_count FROM tag_i18n i WHERE i.tag = c.danbooru_tag), 0) AS posts
       FROM characters c
       WHERE c.name_locked = 0 AND c.danbooru_tag IS NOT NULL AND c.name IN (
         SELECT name FROM characters WHERE danbooru_tag IS NOT NULL GROUP BY name HAVING COUNT(DISTINCT danbooru_tag) > 1)
       ORDER BY c.name, posts DESC`,
    )
    .all() as { id: number; name: string; tag: string }[];
  let lastName = '';
  for (const d of dupes) {
    if (d.name !== lastName) {
      lastName = d.name; // 这一组的第一个（张数最多）保留原名
      continue;
    }
    const next = `${d.name}（${humanizeCharacterTag(d.tag)}）`;
    renamed += setChar.run(next, d.id, next).changes;
  }

  for (const c of db.prepare('SELECT id, name, danbooru_tag AS tag FROM characters WHERE danbooru_tag IS NOT NULL').all() as {
    id: number;
    name: string;
    tag: string;
  }[]) {
    replaceAutoAliases(db, 'character', c.id, localizer.aliasesFor(c.tag, 'character', c.name));
  }
  for (const w of db.prepare('SELECT id, name, danbooru_tag AS tag FROM works WHERE danbooru_tag IS NOT NULL').all() as {
    id: number;
    name: string;
    tag: string;
  }[]) {
    replaceAutoAliases(db, 'work', w.id, localizer.aliasesFor(w.tag, 'work', w.name));
  }
  localizer.invalidate();
  return { renamed };
}
