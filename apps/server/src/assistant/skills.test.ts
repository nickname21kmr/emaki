import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { prepareSkills } from './skills.ts';

const dirs: string[] = [];
const repo = path.resolve(import.meta.dirname, '../../../..');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('ships complete common packages and runs the original report pipeline outside the repository', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'emaki skills ')); dirs.push(root);
  const cwd = path.join(root, 'session'), data = path.join(root, 'library');
  mkdirSync(data);
  const db = new Database(path.join(data, 'emaki.sqlite'));
  db.exec(`CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('correct library');
    CREATE TABLE library_roots(id INTEGER, path TEXT, enabled INTEGER, removed_at TEXT);
    CREATE TABLE images(id INTEGER, root_id INTEGER, file_name TEXT, modified_at TEXT, rating TEXT,
      tagger_model TEXT, tagged_at TEXT, width INTEGER, height INTEGER, added_at TEXT,
      missing INTEGER, trashed_at TEXT, excluded_by TEXT, content_kind TEXT, rel_path TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('secret.danbooruApiKey', '"FAKE-DANBOORU-KEY-7f3a"'), ('ui.theme', '"dark"');`); db.close();
  const skills = prepareSkills(repo, cwd, data, 'http://127.0.0.1:43210');
  expect(skills.map(s => s.name)).toEqual(['emaki-library', 'taste-profile']);
  for (const skill of skills) {
    const body = readFileSync(skill.path, 'utf8');
    for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(readFileSync(path.join(path.dirname(skill.path), match[1]!), 'utf8').length).toBeGreaterThan(0);
    }
  }
  // Helpers linked from references travel with the common package for either harness.
  const helper = 'references/yandex-search.py';
  expect(readFileSync(path.join(path.dirname(skills[0]!.path), helper), 'utf8')).toBe(
    readFileSync(path.join(repo, 'apps/server/assets/assistant/emaki-library', helper), 'utf8'));
  const profile = path.dirname(skills[1]!.path), runner = path.join(profile, 'scripts/run.mjs');
  const env = { ...process.env, EMAKI_DATA_DIR: path.join(root, 'wrong-library') };
  const run = (...args: string[]) => execFileSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: 'utf8' });
  run('snapshot');
  // 各会话共用一个输出目录，整库快照只留一份
  const out = path.join(data, 'profile/assistant');
  const runtime = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.emaki-runtime.json'), 'utf8')).outDir;
  const other = prepareSkills(repo, path.join(root, 'another session'), data, 'http://127.0.0.1:43210');
  expect(runtime(profile)).toBe(out); expect(runtime(path.dirname(other[1]!.path))).toBe(out);
  const snapshot = new Database(path.join(out, 'lib.sqlite'), { readonly: true });
  expect(snapshot.prepare('SELECT value FROM probe').get()).toEqual({ value: 'correct library' });
  // 快照目录助手可免审批读取，凭证不能留在文件里（连删掉的页内残留也不行）
  expect(snapshot.prepare('SELECT key FROM settings').pluck().all()).toEqual(['ui.theme']); snapshot.close();
  const bytes = readFileSync(path.join(out, 'lib.sqlite'));
  expect(bytes.includes('FAKE-DANBOORU-KEY')).toBe(false); expect(bytes.includes('secret.danbooruApiKey')).toBe(false);
  // Exercise the real TypeScript loader without downloading models or images.
  expect(run('wd-sample')).toContain('不需要抽样');
  writeFileSync(path.join(out, 'data.json'), JSON.stringify({ periods: [], fixture: '</script>' }));
  writeFileSync(path.join(out, 'story.json'), JSON.stringify({ title: 'Fixture report' }));
  run('report');
  const html = readFileSync(path.join(out, 'report.html'), 'utf8');
  const template = readFileSync(path.join(repo, '.claude/skills/taste-profile/template.html'), 'utf8');
  const json = (value: unknown) => JSON.stringify(value).replace(/<\//g, '<\\/');
  expect(html).toBe(template.replace('/*DATA*/ null', () => json({ periods: [], fixture: '</script>' }))
    .replace('/*STORY*/ null', () => json({ title: 'Fixture report' }))
    .replace('/*API_BASE_URL*/ "http://127.0.0.1:5174"', () => json('http://127.0.0.1:43210')));
  // Relative user overrides remain relative to the caller, even though the runner changes cwd.
  expect(run('snapshot', '--data', 'library', '--out', 'another output')).toContain('another output');
  const override = new Database(path.join(root, 'another output/lib.sqlite'), { readonly: true });
  expect(override.prepare('SELECT value FROM probe').get()).toEqual({ value: 'correct library' }); override.close();
}, 20000);
