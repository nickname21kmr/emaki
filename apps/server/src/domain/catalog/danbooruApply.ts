/**
 * 把 Danbooru 缓存落到库里：收拢改过名的角色和作品、重挂作品、刷新显示名和自动别名、重算自建角色匹配。
 * 复用 T10 的 CharacterCatalog，不再写第二份 ensureWork / 新建角色；收拢和启动时是同一个函数（附录 #37）。
 */
import type { Db } from '../../db/connection.ts';
import type { Localizer } from '../../services/i18n/localizer.ts';
import type { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { replaceAutoAliases } from './aliases.ts';
import type { CharacterCatalog } from './characterCatalog.ts';
import { consolidateCatalog } from './consolidate.ts';
import { recomputeCustomMatches } from './customMatches.ts';

export interface ApplyDeps {
  db: Db;
  danbooru: DanbooruCatalog;
  getCatalog(): CharacterCatalog;
  localizer: Localizer;
  /** T12 提供：按词库重算所有自动命名的角色 / 作品名；没提供时只刷新自动别名 */
  relocalizeAll?: (db: Db, localizer: Localizer) => void;
  /** 收拢时撞上已有角色就合并：用户手动合并同一个函数。不给就记日志跳过 */
  merge?: (fromId: number, toId: number) => void;
  log?: (msg: string) => void;
}

export function applyToLibrary(deps: ApplyDeps): { renamed: number; merged: number } {
  const { db, danbooru, localizer } = deps;
  const now = new Date().toISOString();
  // 1 收拢：改名之后撞上已有角色就合并（合并自己开事务、记撤销，所以放在下面的事务外面）
  const { characters } = consolidateCatalog(db, { catalog: deps.getCatalog(), localizer, merge: deps.merge, log: deps.log });
  // 2 按 Danbooru 重挂作品（用户手动指定过作品的不动），刷新显示名和自动别名
  const catalog = deps.getCatalog();
  db.transaction(() => {
    const chars = db
      .prepare("SELECT id, danbooru_tag AS tag FROM characters WHERE source = 'danbooru' AND danbooru_tag IS NOT NULL")
      .all() as { id: number; tag: string }[];
    for (const c of chars) catalog.relinkWorks(c.id, danbooru.copyrights(c.tag), now);
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
  return characters;
}
