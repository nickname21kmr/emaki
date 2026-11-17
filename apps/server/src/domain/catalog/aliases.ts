/**
 * 角色 / 作品的别名（aliases 表）只经这里写。
 *
 * 来历（aliases.origin，附录 #37）：
 * - user：用户手动写的（编辑别名）。有 user 别名 = 用户整理过别名，词库和 Danbooru 的别名只供搜索、不显示
 * - auto：编目自己加的、不随词库刷新的——合并角色时被合并角色的名字、收拢改标签时原来的名字（addFormerName）
 * - dict / danbooru：按词库、Danbooru 资料算出来的，replaceAutoAliases 整组删掉重建，只管这两种
 * 位置（position）：用户写的 0–49，合并 / 收拢留下的旧名字 50，词库和 Danbooru 的从 100 起；合并时被合并角色的别名整体加 1000。
 */
import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { AutoAlias } from '../../services/i18n/localizer.ts';

export type AliasOrigin = 'user' | 'auto' | AutoAlias['origin'];

/**
 * 替换某个角色 / 作品按词库、Danbooru 算出来的别名（origin 是 dict / danbooru 的整组重建）；user、auto 的不动。
 * 用户整理过别名（有 user 别名）的对象，这些别名只供搜索不显示；position 从 100 起，排在用户别名后。
 */
export function replaceAutoAliases(db: Db, owner: 'character' | 'work', ownerId: number, list: AutoAlias[]): void {
  const hasUser = db
    .prepare("SELECT 1 FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin = 'user' LIMIT 1")
    .get(owner, ownerId);
  db.prepare("DELETE FROM aliases WHERE owner_type = ? AND owner_id = ? AND origin IN ('dict', 'danbooru')").run(owner, ownerId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  list.forEach((a, i) => ins.run(owner, ownerId, a.alias, searchKey(a.alias), a.origin, hasUser ? 0 : a.visible ? 1 : 0, 100 + i));
}

/**
 * 合并、收拢留下的旧名字（被合并角色的名字、收拢前的名字）加成角色的别名：机器加的，记 auto；显示出来，排在用户别名后。
 * 已有同名别名就不动
 */
export function addFormerName(db: Db, characterId: number, name: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, ?, ?, 'auto', 1, 50)",
  ).run(characterId, name, searchKey(name));
}

/**
 * 合并角色时的别名：目标 = 目标原来的别名 + 被合并角色的名字 + 被合并角色的别名（来历照旧，排在后面）。
 * 撤销记录：撤销时先删掉搬到目标的那几行，再插回被合并角色原来的行；合并之后别处给目标加的别名不动。
 * 调用方要在记 characters 之前调用（docs：撤销逆序，子表最后还原）
 */
export function carryCharacterAliases(db: Db, u: UndoRecorder, from: { id: number; name: string }, to: number): void {
  const added = JSON.stringify(
    db
      .prepare(
        `SELECT alias FROM (SELECT @name AS alias UNION SELECT alias FROM aliases WHERE owner_type = 'character' AND owner_id = @from)
         WHERE alias NOT IN (SELECT alias FROM aliases WHERE owner_type = 'character' AND owner_id = @to)`,
      )
      .pluck()
      .all({ from: from.id, to, name: from.name }),
  );
  u.sql("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ? AND alias IN (SELECT value FROM json_each(?))", [to, added]);
  u.set('aliases', "owner_type = 'character' AND owner_id = ?", [from.id]);
  addFormerName(db, to, from.name);
  db.prepare(
    `INSERT OR IGNORE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position)
     SELECT 'character', @to, alias, search_key, origin, visible, position + 1000 FROM aliases WHERE owner_type = 'character' AND owner_id = @from`,
  ).run({ from: from.id, to });
  db.prepare("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ?").run(from.id);
}

/** 用户编辑别名：替换 origin='user' 的行；用户整理过了，其余来历的别名（auto、dict、danbooru）改成只供搜索 */
export function writeUserAliases(db: Db, characterId: number, aliases: string[]): void {
  db.prepare("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ? AND origin = 'user'").run(characterId);
  const ins = db.prepare(
    "INSERT OR REPLACE INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, ?, ?, 'user', 1, ?)",
  );
  aliases.forEach((a, i) => ins.run(characterId, a, searchKey(a), i));
  db.prepare("UPDATE aliases SET visible = 0 WHERE owner_type = 'character' AND owner_id = ? AND origin <> 'user'").run(characterId);
}
