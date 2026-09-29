import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { replaceAutoAliases } from '../../services/aliases.ts';
import type { Localizer } from '../../services/i18n/localizer.ts';

/**
 * 把已经拆开的角色收拢（2026-09-28）：标签按现在的规则规范化（改名、服装变体归本体）后和原来不同的，
 * 本体已经有角色就合并过去，没有就把这个角色的标签改成本体。每次打开库时跑，已经收拢过的就什么也不做。
 *
 * 起因：换 PixAI 后有些角色标签写法变了（hoshino_ai_(oshi_no_ko) → hoshino_ai），服装变体
 * （minato_aqua_(1st_costume)）以前也各建一个角色，同一个角色被拆成好几个。合并走的是用户手动合并同一个函数（可撤销）。
 */
export function consolidateCharacterTags(
  db: Db,
  deps: {
    normalizeTag: (tag: string) => string;
    localizer: Localizer;
    /** 同 CharacterMutations.merge；有排除规则等情况会抛错，跳过即可 */
    merge: (fromId: number, toId: number) => void;
    log?: (msg: string) => void;
  },
): { merged: number; renamed: number } {
  let merged = 0;
  let renamed = 0;
  const findByTag = db.prepare(
    'SELECT id FROM characters WHERE danbooru_tag = @tag UNION ALL SELECT character_id FROM danbooru_tag_redirects WHERE tag = @tag LIMIT 1',
  );
  // 本体也可能要再归一次（改名之后才看出是变体），最多三轮
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const rows = db.prepare('SELECT id, name, danbooru_tag AS tag FROM characters WHERE danbooru_tag IS NOT NULL ORDER BY id').all() as {
      id: number;
      name: string;
      tag: string;
    }[];
    for (const r of rows) {
      const target = deps.normalizeTag(r.tag);
      if (target === r.tag) continue;
      const to = (findByTag.get({ tag: target }) as { id: number } | undefined)?.id;
      if (to === r.id) continue;
      if (to !== undefined) {
        try {
          deps.merge(r.id, to);
          merged++;
          changed = true;
        } catch (err) {
          deps.log?.(`没有合并「${r.name}」（${r.tag}）：${(err as Error).message}`);
        }
        continue;
      }
      // 本体还没有角色：这个角色直接换成本体的标签；名字是自动起的才跟着换，原来的名字留作别名
      const oldAuto = deps.localizer.characterName(r.tag).name;
      const name = r.name === oldAuto ? deps.localizer.characterName(target).name : r.name;
      db.transaction(() => {
        db.prepare('UPDATE characters SET danbooru_tag = ?, name = ? WHERE id = ?').run(target, name, r.id);
        db.prepare('INSERT OR REPLACE INTO danbooru_tag_redirects (tag, character_id) VALUES (?, ?)').run(r.tag, r.id);
        replaceAutoAliases(db, 'character', r.id, deps.localizer.aliasesFor(target, 'character', name));
        if (name !== r.name) {
          db.prepare(
            "INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, ?, ?, 'user', 1, 50)",
          ).run(r.id, r.name, searchKey(r.name));
        }
      })();
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
 * 新名已经有作品就把旧的并过去（角色、图、合集、手动别名都搬走，然后删掉旧作品），没有就直接改成新名。
 */
export function consolidateWorkTags(
  db: Db,
  deps: {
    /** 只做改名（tag_renames），不做角色的变体归本体 */
    canonicalize: (tag: string) => string;
    localizer: Localizer;
  },
): { merged: number; renamed: number } {
  let merged = 0;
  let renamed = 0;
  const rows = db.prepare('SELECT id, name, danbooru_tag AS tag FROM works WHERE danbooru_tag IS NOT NULL ORDER BY id').all() as {
    id: number;
    name: string;
    tag: string;
  }[];
  const byTag = db.prepare('SELECT id FROM works WHERE danbooru_tag = ?').pluck();
  const s = {
    chars: db.prepare(`INSERT OR IGNORE INTO character_works (character_id, work_id, position)
      SELECT character_id, @to, position FROM character_works WHERE work_id = @from`),
    // 同一张图两边都挂着时：手动挂的（score 为 NULL）优先，否则取高分（SQLite 的 MAX 遇到 NULL 返回 NULL）
    images: db.prepare(`INSERT INTO image_copyrights (image_id, work_id, score)
      SELECT image_id, @to, score FROM image_copyrights WHERE work_id = @from
      ON CONFLICT(image_id, work_id) DO UPDATE SET score = MAX(score, excluded.score)`),
    collections: db.prepare(`INSERT OR IGNORE INTO collection_works (collection_id, work_id, added_at)
      SELECT collection_id, @to, added_at FROM collection_works WHERE work_id = @from`),
    aliases: db.prepare(`INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
      SELECT owner_type, @to, alias, search_key, origin, visible, position FROM aliases
      WHERE owner_type = 'work' AND owner_id = @from AND origin = 'user'`),
    dropAliases: db.prepare("DELETE FROM aliases WHERE owner_type = 'work' AND owner_id = ?"),
    drop: db.prepare('DELETE FROM works WHERE id = ?'),
    rename: db.prepare('UPDATE works SET danbooru_tag = ?, name = ? WHERE id = ?'),
  };
  for (const r of rows) {
    const target = deps.canonicalize(r.tag);
    if (target === r.tag) continue;
    const to = byTag.get(target) as number | undefined;
    db.transaction(() => {
      if (to !== undefined) {
        const p = { from: r.id, to };
        s.chars.run(p);
        s.images.run(p);
        s.collections.run(p);
        s.aliases.run(p);
        s.dropAliases.run(r.id);
        s.drop.run(r.id); // character_works / image_copyrights / collection_works 随外键级联删除
        merged++;
      } else {
        const oldAuto = deps.localizer.workName(r.tag).name;
        const name = r.name === oldAuto ? deps.localizer.workName(target).name : r.name;
        s.rename.run(target, name, r.id);
        replaceAutoAliases(db, 'work', r.id, deps.localizer.aliasesFor(target, 'work', name));
        renamed++;
      }
    })();
  }
  return { merged, renamed };
}
