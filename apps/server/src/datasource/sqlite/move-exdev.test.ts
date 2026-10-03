import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { moveImageFiles } from './move.ts';

// 模拟跨盘（rename 报 EXDEV）而且原文件被占用、删不掉
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const fail = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  return { ...fs, renameSync: fail('EXDEV'), unlinkSync: fail('EBUSY') };
});

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('跨盘移动时原文件删不掉：不留副本，记录不动', () => {
  dir = makeTmpDir('exdev');
  const root = dir.replace(/\\/g, '/');
  mkdirSync(path.join(dir, 'x'));
  writeFileSync(path.join(dir, 'x', 'a.png'), 'a');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE images (id INTEGER PRIMARY KEY, root_id INTEGER, rel_path TEXT, file_name TEXT)');
  db.prepare("INSERT INTO images VALUES (1, 1, 'x/a.png', 'a.png')").run();

  const out = moveImageFiles(
    db,
    [{ id: 1, root_id: 1, rel_path: 'x/a.png', file_name: 'a.png', root_path: root, collection_id: null }],
    { rootId: 1, rootPath: root, dir: 'y' },
  );
  expect(out.moved).toEqual([]);
  expect(out.failed).toEqual(['a.png（EBUSY）']);
  expect(readdirSync(path.join(dir, 'y'))).toEqual([]);
  expect(existsSync(path.join(dir, 'x', 'a.png'))).toBe(true);
  expect(db.prepare('SELECT rel_path FROM images WHERE id = 1').pluck().get()).toBe('x/a.png');
});
