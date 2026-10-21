import { expect, it } from 'vitest';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { backfillSources } from './backfill.ts';

it('upgrades hashed Pixiv names and incorrect hash-tail IDs while keeping manual sources', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  db.exec("INSERT INTO library_roots (path) VALUES ('D:/Pics'); INSERT INTO settings(key,value) VALUES ('sourceParserVersion','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  const name = '147194731-a43ba74e1434ae6ed317cb7671cc2574_p45.jpg';
  const insert = db.prepare(`INSERT INTO images (root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,source_site,source_post_id,source_manual)
    VALUES (1,?,?,1,1,1,'jpg',?,'x','x',?,?,?)`);
  insert.run(name,name,'a','pixiv','2574',0);
  insert.run(`copy/${name}`,name,'b','other','manual-id',1);
  db.exec(`INSERT INTO character_suggestions(image_id,danbooru_tag,score,source) VALUES
    (1,'stale_pixiv_character',0,'pixiv'),(1,'model_character',0.75,'tagger'),(2,'manual_source_suggestion',0,'pixiv')`);
  expect(backfillSources(db)).toBe(1);
  expect(db.prepare('SELECT source_site,source_post_id FROM images ORDER BY id').all()).toEqual([
    {source_site:'pixiv',source_post_id:'147194731'}, {source_site:'other',source_post_id:'manual-id'},
  ]);
  expect(backfillSources(db)).toBe(0);
  expect(db.prepare('SELECT danbooru_tag FROM character_suggestions ORDER BY danbooru_tag').pluck().all()).toEqual(['manual_source_suggestion','model_character']);
  db.close();
});

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
  db.prepare("UPDATE images SET source_manual=1, source_site='other', source_post_id=NULL, source_url='https://example.com/original' WHERE id=1").run();
  db.prepare('UPDATE images SET source_manual=1, source_site=NULL, source_post_id=NULL, source_url=NULL WHERE id=3').run();
  db.prepare("DELETE FROM settings WHERE key='sourceParserVersion'").run();
  expect(backfillSources(db)).toBe(1);
  expect(db.prepare('SELECT source_site, source_url FROM images WHERE id=1').get()).toEqual({ source_site: 'other', source_url: 'https://example.com/original' });
  expect(db.prepare('SELECT source_site, source_url FROM images WHERE id=3').get()).toEqual({ source_site: null, source_url: null });
  db.close();
});
