import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventBus } from '../../../core/events.ts';
import { SqliteDataSource } from '../../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../../test/helpers/tmp.ts';

let ds: SqliteDataSource;
beforeEach(async () => {
  ds = await SqliteDataSource.open(new EventBus(), path.join(makeTmpDir('pixiv-posts'), 'data'), { memory: true, autoJobs: false, importDict: false });
  const db = ds.ctx.db;
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, '//emaki-test/pixiv-posts')");
  const add = db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
    source_site, source_post_id, animated, trashed_at, missing) VALUES (1, ?, ?, 1, 1, 1, ?, ?, 'x', 'x', ?, ?, ?, ?, ?)`);
  // 1001：两页都在，第一页还有一份完全一样的（只算一张）；另有一张在回收站、一张文件不在了（都不算）
  add.run('a/1001_p0.png', '1001_p0.png', 'png', 's1', 'pixiv', '1001', 0, null, 0);
  add.run('b/copy.png', 'copy.png', 'png', 's1', 'pixiv', '1001', 0, null, 0);
  add.run('a/1001_p1.png', '1001_p1.png', 'png', 's2', 'pixiv', '1001', 0, null, 0);
  add.run('a/1001_p2.png', '1001_p2.png', 'png', 's3', 'pixiv', '1001', 0, 'x', 0);
  add.run('a/1001_p3.png', '1001_p3.png', 'png', 's4', 'pixiv', '1001', 0, null, 1);
  // 2002：一个动图；3003：只有回收站里的；4004 是推特的同号
  add.run('a/2002.html', '2002_gif_x.html', 'html', 's5', 'pixiv', '2002', 1, null, 0);
  add.run('a/3003_p0.png', '3003_p0.png', 'png', 's6', 'pixiv', '3003', 0, 'x', 0);
  add.run('a/tw.png', 'tw.png', 'png', 's7', 'twitter', '4004', 0, null, 0);
  // 5005：在停用的图库文件夹里（不算）
  db.exec("INSERT INTO library_roots (id, path, enabled) VALUES (2, '//emaki-test/off', 0)");
  db.prepare(`INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, source_site, source_post_id)
    VALUES (2, '5005_p0.png', '5005_p0.png', 1, 1, 1, 'png', 's8', 'x', 'x', 'pixiv', '5005')`).run();
  db.prepare("INSERT INTO pixiv_artwork_cache (post_id, artwork, fetched_at) VALUES ('1001', ?, 'x')").run(JSON.stringify({ id: '1001', pageCount: 4 }));
});
afterEach(async () => {
  await ds.close();
});

it('这些 Pixiv 作品在图库里各有几张（不同内容的）、几张动图、一共几页（缓存过的）；回收站里的、不在了的、停用的文件夹里的不算', async () => {
  const r = await ds.registry.query<{ posts: Record<string, unknown> }>('images.pixivPosts', { ids: ['1001', '2002', '3003', '4004', '5005'] });
  expect(r.posts).toEqual({
    '1001': { images: 2, animated: 0, pages: 4 },
    '2002': { images: 1, animated: 1, pages: null },
  });
  expect((await ds.registry.query<{ posts: object }>('images.pixivPosts', { ids: [] })).posts).toEqual({});
  await expect(ds.registry.query('images.pixivPosts', { ids: ['abc'] })).rejects.toThrow();
});
