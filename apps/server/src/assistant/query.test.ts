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
  it('terminates expensive queries without blocking the main thread', async () => {
    let ticked = false; const timer = setTimeout(() => { ticked = true; }, 10);
    await expect(queryLibrary(file, 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n', [], 10, 150)).rejects.toThrow('超时');
    clearTimeout(timer); expect(ticked).toBe(true);
  });
});
