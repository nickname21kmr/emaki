/**
 * 迁移 056：以前因为「HTML 动图解码尺寸过大」拒收的大动图（上限放宽了，services/image/htmlAnimation.ts），
 * 删掉出错记录，下次扫描重新读；别的出错照旧留着（文件没变之前不再重试）。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { openDatabase } from './connection.ts';
import { loadMigrations, migrate } from './migrate.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('迁移 056：只删大 HTML 动图的出错记录', () => {
  const db = openDatabase(':memory:');
  const dir = makeTmpDir('migrate-056');
  dirs.push(dir);
  const schema = path.join(dir, 'v55');
  mkdirSync(path.join(schema, 'migrations'), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, 'schema.sql'), path.join(schema, 'schema.sql'));
  const all = loadMigrations();
  for (const m of all.slice(1, 55)) writeFileSync(path.join(schema, 'migrations', m.name), m.sql);
  expect(migrate(db, { dir: schema })).toEqual({ from: 0, to: 55 });
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, '//emaki-test/056')");
  const add = db.prepare("INSERT INTO scan_errors (root_id, rel_path, bytes, modified_at, error, at) VALUES (1, ?, 1, 'x', ?, 'x')");
  add.run('大动图.html', 'HTML 动图解码尺寸过大');
  add.run('坏的.jpg', '读取失败：坏了');
  add.run('别的.html', 'HTML 动图缺少可读取的帧列表');
  writeFileSync(path.join(schema, 'migrations', all[55]!.name), all[55]!.sql);
  expect(all[55]!.name).toBe('056_retry_large_html_animations.sql');
  expect(migrate(db, { dir: schema })).toEqual({ from: 55, to: 56 });
  expect(db.prepare('SELECT rel_path FROM scan_errors ORDER BY rel_path').pluck().all()).toEqual(['别的.html', '坏的.jpg']);
  db.close();
});
