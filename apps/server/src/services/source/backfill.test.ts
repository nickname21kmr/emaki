import { expect, it } from 'vitest';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { backfillSources } from './backfill.ts';

it('只在规则版本变化时重算', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO library_roots (path) VALUES ('D:/Pics')").run();
  const ins = db.prepare(
    "INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (1, ?, ?, 1, 1, 1, 'png', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  );
  for (const [i, p] of ['pixiv/123456789_p0.png', 'IMG_0001.png', 'twitter/a/1789012345678901234_1.jpg'].entries()) {
    ins.run(p, p.split('/').at(-1), `h${i}`);
  }
  expect(backfillSources(db)).toBe(3);
  expect(backfillSources(db)).toBe(0);
  const sites = db.prepare('SELECT source_site FROM images ORDER BY id').pluck().all();
  expect(sites).toEqual(['pixiv', null, 'twitter']);
  db.close();
});
