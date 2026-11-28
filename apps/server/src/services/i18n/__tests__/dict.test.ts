/**
 * importDictIfNeeded 的「要不要读词库文件」：文件没动过（大小、修改时间）、库里记的版本也没变就不读；别的情况照旧读出来比版本。
 * 用一份很小的假词库（真词库的导入在 i18n.test.ts）。
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { importDictIfNeeded } from '../dict.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-dict-'));
const file = path.join(dir, 'dict.json.gz');
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 4 }));

const T1 = new Date('2026-10-01T00:00:00Z');
const T2 = new Date('2026-11-01T00:00:00Z');

/** 写一份词库文件，修改时间定成 at */
function writeDict(revision: string, zh: string, at: Date): void {
  const dict = {
    format: 1,
    source: 'test',
    revision,
    license: 'x',
    generatedAt: 'x',
    tags: { 'mika_(blue_archive)': [4, zh, ['未花'], 'blue_archive', 100] },
    renames: {},
  };
  writeFileSync(file, gzipSync(JSON.stringify(dict)));
  utimesSync(file, at, at);
}

/** 把文件内容换成解不开的垃圾，大小和修改时间不变：之后只要真去读它就会失败 */
function corruptKeepingSignature(): void {
  const st = statSync(file);
  writeFileSync(file, Buffer.alloc(st.size, 0x41));
  utimesSync(file, st.mtime, st.mtime);
  expect(statSync(file).mtimeMs).toBe(st.mtimeMs);
}

let db: Db;
let logs: string[];
const run = () => importDictIfNeeded(db, file, (m) => logs.push(m));
const setting = (key: string) => {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
};
const zhName = () => db.prepare("SELECT zh FROM tag_i18n WHERE tag = 'mika_(blue_archive)'").pluck().get();

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  logs = [];
  writeDict('r1', '圣园未花', T1);
  expect(run()).toMatchObject({ imported: true, count: 1 });
  expect(setting('i18n.dictVersion')).toBe('test@r1#1');
});

it('导入过、文件没动：不再读文件', () => {
  corruptKeepingSignature();
  logs = [];
  expect(run()).toMatchObject({ imported: false, count: 0 });
  expect(logs).toEqual(['中文词库已是最新']);
  expect(zhName()).toBe('圣园未花');
});

it('文件动过但内容还是那个版本：读出来比一次，不导入，记下新的签名（下次又不用读了）', () => {
  writeDict('r1', '圣园未花', T2);
  logs = [];
  expect(run()).toMatchObject({ imported: false, count: 0 });
  expect(logs).toEqual(['中文词库已是最新']);
  expect(setting('i18n.dictFile')).toEqual({ signature: `${statSync(file).size}:${T2.getTime()}`, version: 'test@r1#1' });

  corruptKeepingSignature();
  logs = [];
  expect(run().imported).toBe(false);
  expect(logs).toEqual(['中文词库已是最新']);
});

it('换了新版本的词库：重新导入', () => {
  writeDict('r2', '未花', T2);
  logs = [];
  expect(run()).toMatchObject({ imported: true, count: 1 });
  expect(setting('i18n.dictVersion')).toBe('test@r2#1');
  expect(zhName()).toBe('未花');
});

it('库里记的版本被删掉或改掉（迁移要求重新导入，036 这样做过）：文件没动也重新导入', () => {
  db.prepare("DELETE FROM settings WHERE key = 'i18n.dictVersion'").run();
  expect(run().imported).toBe(true);
  expect(setting('i18n.dictVersion')).toBe('test@r1#1');

  db.prepare(`UPDATE settings SET value = '"other@1#1"' WHERE key = 'i18n.dictVersion'`).run();
  expect(run().imported).toBe(true);
  expect(setting('i18n.dictVersion')).toBe('test@r1#1');
  expect(run().imported).toBe(false);
});

it('文件读不到：记一行日志，不导入，库里的词库不动', () => {
  rmSync(file);
  logs = [];
  expect(run()).toEqual({ imported: false, count: 0, ms: 0 });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('读取中文词库失败');
  expect(zhName()).toBe('圣园未花');
});
