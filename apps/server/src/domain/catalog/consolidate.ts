/**
 * 收拢（附录 #37）：角色、作品的标签按现在的规则规范化后和原来不同的，撞上已有的就合并过去，没有就把标签改成规范的。
 * 启动时和 Danbooru 同步落库后都跑这一个（consolidateCatalog），已经收拢过的就什么也不做。
 * 规范化和解析都走编目唯一的入口（CharacterCatalog.normalizeTag / normalizeWorkTag / resolveCharacterId）。
 */
import type { Db } from '../../db/connection.ts';
import type { Localizer } from '../../services/i18n/localizer.ts';
import { carryCollectionWorks } from '../collections/entityLinks.ts';
import { moveWorkLinks } from '../curation/works.ts';
import { addFormerName, replaceAutoAliases } from './aliases.ts';
import type { CharacterCatalog } from './characterCatalog.ts';

export interface ConsolidateDeps {
  /** 规范化和解析：生产环境是 createCatalog 建的；收拢过程中会改角色，每改一次清一次它的缓存 */
  catalog: CharacterCatalog;
  localizer: Localizer;
  /**
   * 撞上已有角色时合并：和用户手动合并是同一个函数（CharacterMutations.merge，可撤销）。
   * 有排除规则等合并不了的会抛错，记日志跳过；不给（只在测试里）就都记日志跳过
   */
  merge?: (fromId: number, toId: number) => void;
  log?: (msg: string) => void;
}

export interface ConsolidateResult {
  merged: number;
  renamed: number;
}

/** 角色和作品一起收拢 */
export function consolidateCatalog(db: Db, deps: ConsolidateDeps): { characters: ConsolidateResult; works: ConsolidateResult } {
  return { characters: consolidateCharacterTags(db, deps), works: consolidateWorkTags(db, deps) };
}

/**
 * 把已经拆开的角色收拢（2026-09-28）：标签规范化（改名、服装变体归本体、核验过的身份）后和原来不同的，
 * 规范的标签已经有角色（含合并重定向）就合并过去，没有就把这个角色的标签改成规范的，旧标签留一条重定向。
 * 改标签时名字没被用户改过（name_locked = 0）才跟着换成新标签的名字，原来的名字留作别名（auto）。
 *
 * 起因：换 PixAI 后有些角色标签写法变了（hoshino_ai_(oshi_no_ko) → hoshino_ai），服装变体
 * （minato_aqua_(1st_costume)）以前也各建一个角色，同一个角色被拆成好几个；Danbooru 改名后同步落库也会撞上。
 */
export function consolidateCharacterTags(db: Db, deps: ConsolidateDeps): ConsolidateResult {
  const { catalog, localizer } = deps;
  let merged = 0;
  let renamed = 0;
  // 本体也可能要再归一次（改名之后才看出是变体），最多三轮
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const rows = db
      .prepare('SELECT id, name, name_locked, danbooru_tag AS tag FROM characters WHERE danbooru_tag IS NOT NULL ORDER BY id')
      .all() as { id: number; name: string; name_locked: number; tag: string }[];
    for (const r of rows) {
      const target = catalog.normalizeTag(r.tag);
      if (target === r.tag) continue;
      const to = catalog.resolveCharacterId(target);
      if (to === r.id) continue;
      if (to !== null) {
        if (!deps.merge) {
          deps.log?.(`没有合并「${r.name}」（${r.tag}）：${target} 已属于角色 #${to}，留给用户合并`);
          continue;
        }
        try {
          deps.merge(r.id, to);
          merged++;
          changed = true;
        } catch (err) {
          deps.log?.(`没有合并「${r.name}」（${r.tag}）：${(err as Error).message}`);
        }
        catalog.clearCache();
        continue;
      }
      // 规范的标签还没有角色：这个角色直接换成规范的标签
      const name = r.name_locked ? r.name : localizer.characterName(target).name;
      db.transaction(() => {
        db.prepare('UPDATE characters SET danbooru_tag = ?, name = ? WHERE id = ?').run(target, name, r.id);
        db.prepare('INSERT OR REPLACE INTO danbooru_tag_redirects (tag, character_id) VALUES (?, ?)').run(r.tag, r.id);
        replaceAutoAliases(db, 'character', r.id, localizer.aliasesFor(target, 'character', name));
        if (name !== r.name) addFormerName(db, r.id, r.name);
      })();
      catalog.clearCache();
      renamed++;
      changed = true;
    }
    if (!changed) break;
  }
  return { merged, renamed };
}

/**
 * 作品也一样（用户 2026-09-29）：Danbooru 改过名的版权标签（alice_in_wonderland → alice's_adventures_in_wonderland），
 * 旧模型按旧名、新模型按新名各建了一部作品，旧的那部通常没有角色，只挂着几张图，看起来像空文件夹。
 * 新名已经有作品就把旧的并过去（角色、图、合集、手动和合并留下的别名都搬走，然后删掉旧作品），没有就直接改成新名
 * （名字没被用户改过才跟着换）。作品只按改名表规范化（normalizeWorkTag），不套角色的服装变体规则。
 */
export function consolidateWorkTags(db: Db, deps: Pick<ConsolidateDeps, 'catalog' | 'localizer'>): ConsolidateResult {
  let merged = 0;
  let renamed = 0;
  const rows = db.prepare('SELECT id, name, name_locked, danbooru_tag AS tag FROM works WHERE danbooru_tag IS NOT NULL ORDER BY id').all() as {
    id: number;
    name: string;
    name_locked: number;
    tag: string;
  }[];
  const byTag = db.prepare('SELECT id FROM works WHERE danbooru_tag = ?').pluck();
  const s = {
    chars: db.prepare(`INSERT OR IGNORE INTO character_works (character_id, work_id, position)
      SELECT character_id, @to, position FROM character_works WHERE work_id = @from`),
    aliases: db.prepare(`INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
      SELECT owner_type, @to, alias, search_key, origin, visible, position FROM aliases
      WHERE owner_type = 'work' AND owner_id = @from AND origin IN ('user', 'auto')`),
    dropAliases: db.prepare("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?"),
    drop: db.prepare('DELETE FROM works WHERE id = ?'),
    rename: db.prepare('UPDATE works SET danbooru_tag = ?, name = ? WHERE id = ?'),
  };
  for (const r of rows) {
    const target = deps.catalog.normalizeWorkTag(r.tag);
    if (target === r.tag) continue;
    const to = byTag.get(target) as number | undefined;
    db.transaction(() => {
      if (to !== undefined) {
        const p = { from: r.id, to };
        s.chars.run(p);
        // 手动指定的作品跟着搬（归类模块）；作品证据按标签记，不用搬
        moveWorkLinks(db, p.from, p.to);
        carryCollectionWorks(db, r.id, to); // 合集模块
        s.aliases.run(p);
        s.dropAliases.run(r.id);
        s.drop.run(r.id); // character_works / image_copyrights / collection_works 随外键级联删除
        merged++;
      } else {
        const name = r.name_locked ? r.name : deps.localizer.workName(target).name;
        s.rename.run(target, name, r.id);
        replaceAutoAliases(db, 'work', r.id, deps.localizer.aliasesFor(target, 'work', name));
        renamed++;
      }
    })();
  }
  return { merged, renamed };
}
