/**
 * 把 Danbooru 缓存落到库里：角色标签改名、重挂作品、刷新自动别名、重算自建角色匹配。
 * 复用 T10 的 CharacterCatalog，不再写第二份 ensureWork / 新建角色。
 */
import type { Db } from '../../db/connection.ts';
import { replaceAutoAliases } from '../aliases.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { Localizer } from '../i18n/localizer.ts';
import type { DanbooruCatalog } from './catalog.ts';
import { recomputeCustomMatches } from './matcher.ts';

export interface ApplyDeps {
  db: Db;
  danbooru: DanbooruCatalog;
  getCatalog(): CharacterCatalog;
  localizer: Localizer;
  /** T12 提供：按词库重算所有自动命名的角色 / 作品名；没提供时只刷新自动别名 */
  relocalizeAll?: (db: Db, localizer: Localizer) => void;
  log?: (msg: string) => void;
}

export function applyToLibrary(deps: ApplyDeps): { renamed: number } {
  const { db, danbooru, localizer } = deps;
  const catalog = deps.getCatalog();
  const now = new Date().toISOString();
  let renamed = 0;
  db.transaction(() => {
    const chars = db
      .prepare("SELECT id, danbooru_tag AS tag FROM characters WHERE source = 'danbooru' AND danbooru_tag IS NOT NULL")
      .all() as { id: number; tag: string }[];
    const taken = db.prepare('SELECT id FROM characters WHERE danbooru_tag = ?').pluck();
    const setTag = db.prepare('UPDATE characters SET danbooru_tag = ? WHERE id = ?');
    for (const c of chars) {
      const canon = danbooru.canonicalize(c.tag);
      let tag = c.tag;
      if (canon !== c.tag) {
        const other = taken.get(canon) as number | undefined;
        if (other === undefined) {
          setTag.run(canon, c.id);
          tag = canon;
          renamed++;
        } else {
          deps.log?.(`角色 #${c.id} 的标签 ${c.tag} 已改名为 ${canon}，但它已属于角色 #${other}：留给用户合并`);
        }
      }
      catalog.relinkWorks(c.id, danbooru.copyrights(tag), now);
    }
    if (deps.relocalizeAll) {
      deps.relocalizeAll(db, localizer);
    } else {
      for (const c of db.prepare("SELECT id, name, danbooru_tag AS tag FROM characters WHERE danbooru_tag IS NOT NULL").all() as {
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
    }
  })();
  recomputeCustomMatches(db, danbooru);
  return { renamed };
}
