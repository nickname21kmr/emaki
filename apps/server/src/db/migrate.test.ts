import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { loadMigrations, migrate } from './migrate.ts';

const latest = loadMigrations().at(-1)!.version;

/** 把 v1..v<upTo> 的迁移复制到 dir，用来让库停在旧版本或在后面追加迁移 */
function copyMigrations(dir: string, upTo = latest): void {
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(dir, 'schema.sql'));
  mkdirSync(path.join(dir, 'migrations'));
  for (const m of loadMigrations().slice(1, upTo)) writeFileSync(path.join(dir, 'migrations', m.name), m.sql);
}

describe('migrate', () => {
  let db: Db;
  let dir: string;
  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = makeTmpDir('migrate');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('全新库升到最新版本，并建好视图', () => {
    expect(migrate(db)).toEqual({ from: 0, to: latest });
    expect(db.pragma('user_version', { simple: true })).toBe(latest);
    const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").pluck().all();
    expect(views).toEqual(['v_counted_images', 'v_illust_images', 'v_image_works', 'v_images']);
    const cols = (db.prepare('PRAGMA table_info(images)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['content_kind', 'content_kind_manual', 'camera', 'theme', 'art_score', 'shelved_at']));
  });

  it('重复执行是幂等的', () => {
    migrate(db);
    expect(migrate(db)).toEqual({ from: latest, to: latest });
  });

  it('029: upgrades comparison storage and schedules a recheck without changing the search preference', () => {
    copyMigrations(dir, 25);
    migrate(db, { dir });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('dedupe', JSON.stringify({ hammingThreshold: 4, lastRunAt: '2026-10-01' }));
    migrate(db);
    expect(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'dedupe'").pluck().get() as string)).toEqual({ hammingThreshold: 4, lastRunAt: null });
    expect(db.prepare('SELECT count(*) FROM duplicate_comparisons').pluck().get()).toBe(0);
  });

  it('坏迁移整体回滚，user_version 不变', () => {
    // 复制一份迁移目录，追加一个会失败的迁移
    copyMigrations(dir);
    const bad = String(latest + 1).padStart(3, '0');
    writeFileSync(path.join(dir, 'migrations', `${bad}_bad.sql`), 'CREATE TABLE ok_table (x);\nSELECT * FROM no_such_table;');
    migrate(db);
    expect(() => migrate(db, { dir })).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(latest);
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'ok_table'").pluck().get()).toBe(0);
  });

  it('降级保护', () => {
    migrate(db);
    db.pragma('user_version = 99');
    expect(() => migrate(db)).toThrow(/比程序支持的/);
  });

  it('022：emaki:character 占位建议回填 character_id，角色已经不在的删掉；之后删角色级联删建议', () => {
    copyMigrations(dir, 21);
    migrate(db, { dir });
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
        VALUES (1, 1, 'a.png', 'a.png', 1, 1, 1, 'png', 's1', 'x', 'x');
      INSERT INTO characters (id, name, source, created_at) VALUES (5, '小雪', 'custom', 'x');
      INSERT INTO character_suggestions (image_id, danbooru_tag, score, source) VALUES
        (1, 'emaki:character:5', 0, 'pixiv'), (1, 'emaki:character:9', 0, 'pixiv'), (1, 'hina_(blue_archive)', 0.4, 'tagger');
      INSERT INTO pixiv_character_checks (image_id, post_id, modified_at) VALUES (1, '123', 'x');`);
    migrate(db);
    const rows = () => db.prepare('SELECT danbooru_tag, character_id FROM character_suggestions ORDER BY danbooru_tag').all();
    expect(rows()).toEqual([
      { danbooru_tag: 'emaki:character:5', character_id: 5 },
      { danbooru_tag: 'hina_(blue_archive)', character_id: null },
    ]);
    expect(db.prepare('SELECT result FROM pixiv_character_checks').pluck().all()).toEqual([null]);
    db.exec('DELETE FROM characters WHERE id = 5');
    expect(rows()).toEqual([{ danbooru_tag: 'hina_(blue_archive)', character_id: null }]);
  });

  it('022：伪标签的编号已经被 Danbooru 角色占用的，删掉，不挂到那个角色上', () => {
    copyMigrations(dir, 21);
    migrate(db, { dir });
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
        VALUES (1, 1, 'a.png', 'a.png', 1, 1, 1, 'png', 's1', 'x', 'x');
      INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (7, '后来新建的', 'reused_(x)', 'danbooru', 'x');
      INSERT INTO character_suggestions (image_id, danbooru_tag, score, source) VALUES (1, 'emaki:character:7', 0, 'pixiv');`);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) FROM character_suggestions').pluck().get()).toBe(0);
  });
});

describe('升级前备份', () => {
  let db: Db;
  let dir: string;
  let dataDir: string;
  let migDir: string;
  let logs: string[];
  const bak = (v: number) => `emaki.v${v}.bak.sqlite`;
  const others = [
    'emaki.before-merge.bak.sqlite',
    'emaki.before-restore.bak.sqlite',
    'emaki.sqlite',
    'emaki.sqlite-shm',
    'emaki.sqlite-wal',
    'emaki.v10.bak.sqlite-wal',
  ];

  beforeEach(() => {
    db = openDatabase(':memory:');
    dir = makeTmpDir('migrate-bak');
    dataDir = path.join(dir, 'data');
    migDir = path.join(dir, 'mig');
    mkdirSync(dataDir);
    mkdirSync(migDir);
    for (let v = 10; v <= 16; v++) writeFileSync(path.join(dataDir, bak(v)), 'old');
    for (const f of others) writeFileSync(path.join(dataDir, f), 'keep');
    logs = [];
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (o: { dir?: string } = {}) => migrate(db, { ...o, backupDir: dataDir, log: (m) => logs.push(m) });

  it('只留刚做的和之前最近的一份，别的文件不动', () => {
    expect(latest).toBeGreaterThan(16);
    migrate(db);
    copyMigrations(migDir);
    const next = String(latest + 1).padStart(3, '0');
    writeFileSync(path.join(migDir, 'migrations', `${next}_probe.sql`), 'CREATE TABLE probe (x);');

    expect(run({ dir: migDir })).toEqual({ from: latest, to: latest + 1 });
    expect(readdirSync(dataDir).sort()).toEqual([...others, bak(16), bak(latest)].sort());
    // 新备份是真的库，不是占位文件
    const copy = openDatabase(path.join(dataDir, bak(latest)));
    expect(copy.pragma('user_version', { simple: true })).toBe(latest);
    copy.close();
    for (let v = 10; v <= 15; v++) expect(logs.some((m) => m.includes('已删除旧备份') && m.includes(bak(v)))).toBe(true);
  });

  it('比当前版本新的备份不动（恢复过旧库）', () => {
    copyMigrations(migDir, 12);
    migrate(db, { dir: migDir });
    run();
    expect(readdirSync(dataDir).sort()).toEqual([...others, bak(11), bak(12), bak(13), bak(14), bak(15), bak(16)].sort());
  });

  it('删不掉不影响迁移', () => {
    // 同名目录让 rmSync 报错
    rmSync(path.join(dataDir, bak(10)));
    mkdirSync(path.join(dataDir, bak(10)));
    writeFileSync(path.join(dataDir, bak(10), 'x'), 'x');
    copyMigrations(migDir, 12);
    migrate(db, { dir: migDir });

    expect(run()).toEqual({ from: 12, to: latest });
    expect(existsSync(path.join(dataDir, bak(10), 'x'))).toBe(true);
    expect(logs.some((m) => m.includes('删除旧备份失败'))).toBe(true);
  });

  it('没有待执行的迁移时不备份也不清理', () => {
    migrate(db);
    run();
    expect(readdirSync(dataDir).sort()).toEqual([...others, ...[10, 11, 12, 13, 14, 15, 16].map(bak)].sort());
  });
});
