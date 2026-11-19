import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { syncRootModes } from './rootMode.ts';

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.exec(`INSERT INTO library_roots (id, path, content_mode, comic_rating) VALUES (1, 'D:/漫画', 'comic', 'sensitive'), (2, 'D:/插画', 'auto', 'general');
    INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source, content_kind_evidence, content_kind_manual, rating, rating_manual, tagged_at)
    VALUES
      (1, 1, 'v1/a.png', 'a.png', 100, 150, 1, 'png', 's1', 'x', 'x', 'illustration', 'default', NULL, 0, 'general', 0, NULL),
      (2, 1, 'v1/b.png', 'b.png', 100, 150, 1, 'png', 's2', 'x', 'x', 'text', 'manual', NULL, 1, 'explicit', 1, NULL),
      (3, 1, 'v1/c.png', 'c.png', 100, 150, 1, 'png', 's3', 'x', 'x', 'comic', 'folder', '按漫画导入的文件夹', 0, 'questionable', 0, 'x'),
      (4, 2, 'd.png', 'd.png', 100, 150, 1, 'png', 's4', 'x', 'x', 'comic', 'folder', '按漫画导入的文件夹', 0, 'sensitive', 0, NULL);`);
});
afterEach(() => db.close());

const rows = () =>
  db.prepare('SELECT id, content_kind AS k, content_kind_source AS s, rating AS r FROM images ORDER BY id').all() as { id: number; k: string; s: string; r: string }[];

it('漫画文件夹里没按漫画判的、移出漫画文件夹还按漫画判的，都按现在的设置改过来；手动改过的不动', () => {
  expect(syncRootModes(db)).toBeGreaterThan(0);
  expect(rows()).toEqual([
    { id: 1, k: 'comic', s: 'folder', r: 'sensitive' }, // 扫描时还没切换：改成漫画、用文件夹的分级
    { id: 2, k: 'text', s: 'manual', r: 'explicit' }, // 手动改过类型、分级
    { id: 3, k: 'comic', s: 'folder', r: 'questionable' }, // 识别过的分级不动
    { id: 4, k: 'illustration', s: 'default', r: 'sensitive' }, // 移出了漫画文件夹
  ]);
  expect(syncRootModes(db)).toBe(0);
});

it('只查给的 ids', () => {
  expect(syncRootModes(db, [4])).toBe(1);
  expect(rows()[0]).toMatchObject({ k: 'illustration', r: 'general' });
});
