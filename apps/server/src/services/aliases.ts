import { searchKey } from '@emaki/shared';
import type { Db } from '../db/connection.ts';
import type { AutoAlias } from './i18n/localizer.ts';

/**
 * 替换某个角色 / 作品的自动别名；用户手动写的（origin='user'）不动。
 * 用户整理过别名的对象，自动别名只供搜索不显示；自动别名 position 从 100 起，排在用户别名后。
 */
export function replaceAutoAliases(db: Db, owner: 'character' | 'work', ownerId: number, list: AutoAlias[]): void {
  const hasUser = db
    .prepare("SELECT 1 FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin = 'user' LIMIT 1")
    .get(owner, ownerId);
  db.prepare("DELETE FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin <> 'user'").run(owner, ownerId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  list.forEach((a, i) => ins.run(owner, ownerId, a.alias, searchKey(a.alias), a.origin, hasUser ? 0 : a.visible ? 1 : 0, 100 + i));
}
