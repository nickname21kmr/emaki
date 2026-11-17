/**
 * 迁移 036（编目的来历，P3b，附录 #37）：造一个停在 v35 的库，覆盖各种旧别名，迁移之后逐条核对。
 * 不变量：别名条数、每一行的别名 / 位置 / 可见性都不变，只改来历；只有合并 / 收拢写的（角色别名、user、position % 1000 = 50）
 * 改成 auto，其余原样。改过的库下次启动重新导入词库（刷新被藏起来的自动别名），没改过的不动。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { openDatabase, type Db } from './connection.ts';
import { loadMigrations, migrate } from './migrate.ts';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = makeTmpDir('migrate-036');
  // 迁移目录只放到 v35，库停在迁移 036 之前
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(dir, 'schema.sql'));
  mkdirSync(path.join(dir, 'migrations'));
  for (const m of loadMigrations().slice(1, 35)) writeFileSync(path.join(dir, 'migrations', m.name), m.sql);
  expect(migrate(db, { dir })).toEqual({ from: 0, to: 35 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = '2026-01-01T00:00:00.000Z';

interface AliasRow {
  owner_type: string;
  owner_id: number;
  alias: string;
  origin: string;
  visible: number;
  position: number;
}
const aliases = () =>
  db.prepare('SELECT owner_type, owner_id, alias, origin, visible, position FROM aliases ORDER BY owner_type, owner_id, alias').all() as AliasRow[];

function seedAliases(): void {
  db.exec(`
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES
      (1, '圣园未花', 'mika_(blue_archive)', 'danbooru', '${T}'), (2, '自建', NULL, 'custom', '${T}');
    INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '蔚蓝档案', 'blue_archive', '${T}');
  `);
  const ins = db.prepare('INSERT INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const rows: [string, number, string, string, number, number][] = [
    // 用户编辑别名写的：0–49
    ['character', 1, 'ミカ', 'user', 1, 0],
    ['character', 1, '未花', 'user', 1, 49],
    // 合并时加的被合并角色的名字 / 收拢留下的旧名字
    ['character', 1, '小未花', 'user', 1, 50],
    // 被合并角色身上的：它自己的用户别名（+1000）、它当初合并 / 收拢留下的名字（+1000）、再合并一次（+2000）
    ['character', 1, 'みか', 'user', 1, 1003],
    ['character', 1, '旧名', 'user', 1, 1050],
    ['character', 1, '更旧的名', 'user', 1, 2050],
    // 词库 / Danbooru 的（被藏起来了）
    ['character', 1, 'Mika', 'dict', 0, 100],
    ['character', 1, '150位', 'danbooru', 0, 150],
    ['character', 2, 'yukimi', 'user', 1, 0],
    // 作品的别名没有合并 / 收拢这样写过：position 50 的也判断不了，保持 user
    ['work', 1, 'BA', 'user', 1, 50],
    ['work', 1, 'ブルアカ', 'dict', 1, 100],
  ];
  for (const [type, id, alias, origin, visible, position] of rows) ins.run(type, id, alias, alias, origin, visible, position);
}

it('合并 / 收拢写的角色别名改成 auto，其余原样；条数、位置、可见性都不变', () => {
  seedAliases();
  const before = aliases();
  expect(migrate(db)).toMatchObject({ from: 35 });
  const after = aliases();
  expect(after).toHaveLength(before.length);
  const changed = new Set(['小未花', '旧名', '更旧的名']);
  expect(after).toEqual(before.map((r) => (r.owner_type === 'character' && changed.has(r.alias) ? { ...r, origin: 'auto' } : r)));
  // 角色 1 剩下的 user 别名都是用户自己写的
  expect(after.filter((r) => r.owner_id === 1 && r.owner_type === 'character' && r.origin === 'user').map((r) => r.position).sort((a, b) => a - b)).toEqual([0, 49, 1003]);
});

it('改过别名来历的库：去掉词库版本，下次启动重新导入词库、刷新自动别名；没改过的不动', () => {
  const setVersion = () =>
    db.prepare("INSERT INTO settings (key, value) VALUES ('i18n.dictVersion', '\"dict@1#1\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const version = () => db.prepare("SELECT value FROM settings WHERE key = 'i18n.dictVersion'").pluck().get();
  setVersion();
  seedAliases();
  migrate(db);
  expect(version()).toBeUndefined();

  // 另一个库：没有合并 / 收拢写的别名
  db.close();
  db = openDatabase(':memory:');
  migrate(db, { dir });
  setVersion();
  db.exec(`INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, 'a', NULL, 'custom', '${T}');
    INSERT INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', 1, 'x', 'x', 'user', 1, 0);`);
  migrate(db);
  expect(version()).toBe('"dict@1#1"');
});
