import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { queryLibrary } from './query.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'emaki-query-test-'));
const file = path.join(dir, 'library.sqlite');
const db = new Database(file);
db.exec('CREATE TABLE images(id INTEGER PRIMARY KEY, kind TEXT); INSERT INTO images VALUES(1,\'photo\'),(2,\'photo\'),(3,\'illustration\');');
// 和真实库一样，settings 里放着凭据
db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES('secret.danbooruApiKey','"FAKE-KEY-123"');
  CREATE TABLE kinds(kind TEXT PRIMARY KEY, label TEXT); INSERT INTO kinds VALUES('photo','照片'),('illustration','插画');
  CREATE VIEW v_settings AS SELECT * FROM settings;`);
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
describe('assistant SQL', () => {
  it('allows aggregation and CTEs and reports truncation', async () => {
    const grouped = await queryLibrary(file, 'WITH counts AS (SELECT kind,count(*) AS n FROM images GROUP BY kind) SELECT * FROM counts ORDER BY n DESC');
    expect(grouped.rows[0]).toEqual({ kind: 'photo', n: 2 });
    const bounded = await queryLibrary(file, 'SELECT * FROM images ORDER BY id', [], 2);
    expect(bounded.rows).toHaveLength(2); expect(bounded.truncated).toBe(true);
  });
  it.each(['DELETE FROM images', "ATTACH DATABASE ':memory:' AS other", 'PRAGMA query_only=OFF', 'WITH x AS (SELECT 1) DELETE FROM images', 'SELECT 1; DELETE FROM images'])('rejects mutation %s', async sql => {
    await expect(queryLibrary(file, sql)).rejects.toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM images').get()).toEqual({ n: 3 });
  });
  it.each([
    'SELECT key, value FROM settings',
    'SELECT * FROM "SETTINGS"',
    'SELECT value FROM main.[settings] WHERE key = ?',
    'SELECT count(*) FROM settings',
    'SELECT key FROM settings',
    'SELECT * FROM v_settings',
    'WITH s AS (SELECT * FROM settings) SELECT * FROM s',
    'SELECT i.id, s.value FROM images i JOIN settings s ON s.key LIKE \'secret.%\'',
    'SELECT id FROM images WHERE EXISTS (SELECT 1 FROM settings WHERE substr(value, 2, 1) = \'F\')',
    'SELECT (SELECT group_concat(value) FROM settings) AS v',
  ])('rejects reading credentials: %s', async sql => {
    const params = sql.includes('?') ? ['secret.danbooruApiKey'] : [];
    await expect(queryLibrary(file, sql, params)).rejects.toThrow('凭据');
  });
  it('keeps normal queries, joins and EXPLAIN working next to the settings table', async () => {
    const joined = await queryLibrary(file, 'SELECT i.id, k.label FROM images i JOIN kinds k ON k.kind = i.kind WHERE i.kind = ? ORDER BY i.id', ['illustration']);
    expect(joined.rows).toEqual([{ id: 3, label: '插画' }]);
    const tables = await queryLibrary(file, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name");
    expect(tables.rows.map(r => r.name)).toContain('settings');
    const plan = await queryLibrary(file, 'EXPLAIN QUERY PLAN SELECT * FROM settings');
    expect(JSON.stringify(plan.rows)).not.toContain('FAKE-KEY');
  });
  it('terminates expensive queries without blocking the main thread', async () => {
    let ticked = false; const timer = setTimeout(() => { ticked = true; }, 10);
    await expect(queryLibrary(file, 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n', [], 10, 150)).rejects.toThrow('超时');
    clearTimeout(timer); expect(ticked).toBe(true);
  });
});
