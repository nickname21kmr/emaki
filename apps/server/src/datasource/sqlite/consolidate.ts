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
