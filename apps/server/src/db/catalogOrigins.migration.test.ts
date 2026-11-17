/**
 * 迁移 036（编目的来历，P3b，附录 #37）：造一个停在 v35 的库，覆盖各种旧别名和解绑过的角色，迁移之后逐条核对。
 * 不变量：
 * - 别名条数、每一行的别名 / 位置 / 可见性都不变，只改来历；只有合并 / 收拢写的（角色别名、user、position % 1000 = 50）
 *   改成 auto，其余原样。改过的库下次启动重新导入词库（刷新被藏起来的自动别名），没改过的不动；
 * - 角色条数、标签不变；只有「source = danbooru、标签已清空、能从关联证据认出原来标签」的改成 custom，并忽略那个标签；
 *   认不出的、还绑着的、本来就是自建的都不动；关联一条不动。
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

it('解绑过 Danbooru 的角色：认得出原来标签的改成自建并忽略那个标签，认不出的保持原样；其余角色不动', () => {
  db.exec(`
    INSERT INTO library_roots (id, path) VALUES (1, '//old/lib');
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES
      (1, '解绑过·有证据', NULL, 'danbooru', '${T}'),
      (2, '解绑过·没证据', NULL, 'danbooru', '${T}'),
      (3, '绑着的', 'bound_tag', 'danbooru', '${T}'),
      (4, '自建', NULL, 'custom', '${T}'),
      (5, '解绑过·有旧匹配', NULL, 'danbooru', '${T}'),
      (6, '解绑过·只有占位标签', NULL, 'danbooru', '${T}');
    INSERT INTO custom_character_matches (character_id, danbooru_tag, score, reason, existing_character_id, dismissed, computed_at)
      VALUES (5, 'some_other', 0.9, 'zh:x', NULL, 0, '${T}');
  `);
  const img = db.prepare(
    "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x')",
  );
  for (let id = 1; id <= 8; id++) img.run(id, `${id}.png`, `${id}.png`, `s${id}`);
  const link = db.prepare(
    "INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_tag, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // 角色 1：两张按 nia_liston 自动归的、一张按别的标签、一张手动归的（没有证据）
  link.run(1, 1, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 'nia_liston', T);
  link.run(2, 1, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 'nia_liston', T);
  link.run(3, 1, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 'nia_(alt)', T);
  link.run(4, 1, 'manual', 'user', null, null, null, T);
  // 角色 2：只有手动的
  link.run(5, 2, 'manual', 'user', null, null, null, T);
  // 角色 5：单张采纳（手动、带证据）
  link.run(6, 5, 'manual', 'user', null, 'tagger', 'old_five', T);
  // 角色 6：Pixiv 给自建角色的占位标签不算
  link.run(7, 6, 'auto', 'job:pixiv', 'pixiv@1', 'pixiv', 'emaki:character:6', T);

  const chars = () => db.prepare('SELECT id, danbooru_tag, source FROM characters ORDER BY id').all();
  const before = chars();
  migrate(db);
  expect(chars()).toEqual(
    (before as { id: number; danbooru_tag: string | null; source: string }[]).map((c) => (c.id === 1 || c.id === 5 ? { ...c, source: 'custom' } : c)),
  );
  const matches = db.prepare('SELECT character_id, danbooru_tag, reason, dismissed FROM custom_character_matches ORDER BY character_id').all();
  expect(matches).toEqual([
    { character_id: 1, danbooru_tag: 'nia_liston', reason: 'unbound', dismissed: 1 },
    { character_id: 5, danbooru_tag: 'old_five', reason: 'zh:x', dismissed: 1 },
  ]);
  // 关联一条不动
  expect(db.prepare('SELECT count(*) FROM image_characters').pluck().get()).toBe(7);
});
