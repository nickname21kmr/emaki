import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { loadMigrations, migrate } from './migrate.ts';

const latest = loadMigrations().at(-1)!.version;

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

  it('坏迁移整体回滚，user_version 不变', () => {
    // 复制一份迁移目录，追加一个会失败的迁移
    const src = path.join(import.meta.dirname);
    copyFileSync(path.join(src, 'schema.sql'), path.join(dir, 'schema.sql'));
    mkdirSync(path.join(dir, 'migrations'));
    for (const m of loadMigrations().slice(1)) writeFileSync(path.join(dir, 'migrations', m.name), m.sql);
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
});
