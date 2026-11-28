/**
 * 画师列表走结果缓存（键 'artists'）：没变化时不重算；手动合并 / 拆开、改分级之后立刻是新的；
 * 「识别画师」任务和 Danbooru 同步直接写库（不声明变化）之后也立刻是新的（artistsStamp）。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { writeArtists } from '../../services/tagger/artists.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';

let dir: string;
let ds: SqliteDataSource;

beforeEach(async () => {
  dir = makeTmpDir('artists-cache');
  ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  const db = ds.ctx.db;
  db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
  const add = db.prepare(
    `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, rating, tagged_at)
     VALUES (?, 1, ?, ?, 100, 140, 1, 'png', ?, 'x', 'x', 'illustration', 'general', 'x')`,
  );
  for (const id of [1, 2, 3, 4, 5]) add.run(id, `${id}.png`, `${id}.png`, `s${id}`);
  db.transaction(() => {
    writeArtists(db, 1, [['kantoku', 0.98]], 'x');
    writeArtists(db, 2, [['kantoku', 0.6]], 'x');
    writeArtists(db, 3, [['mishima_kurone', 0.9]], 'x');
  })();
  ds.ctx.invalidate();
});
afterEach(async () => {
  await ds.close();
  rmSync(dir, { recursive: true, force: true });
});

const brief = async () => (await ds.listArtists()).map((a) => [a.tag, a.name, a.imageCount, a.tags.slice().sort().join('+')]);

it('没有变化时返回缓存里的同一份；手动合并画师后立刻是新的，撤销也是', async () => {
  const first = await ds.listArtists();
  expect(await ds.listArtists()).toBe(first);
  expect(await brief()).toEqual([
    ['kantoku', 'kantoku', 2, 'kantoku'],
    ['mishima_kurone', 'mishima kurone', 1, 'mishima_kurone'],
  ]);

  const merged = await ds.updateArtistLinks({ mode: 'merge', tags: ['mishima_kurone'], into: 'kantoku' });
  expect(await brief()).toEqual([['kantoku', 'kantoku', 3, 'kantoku+mishima_kurone']]);
  await ds.undo(merged.undoToken!);
  expect(await brief()).toEqual([
    ['kantoku', 'kantoku', 2, 'kantoku'],
    ['mishima_kurone', 'mishima kurone', 1, 'mishima_kurone'],
  ]);
});

it('改分级、排除之后封面和张数跟着变（敏感封面要打码，不能用旧的）', async () => {
  expect((await ds.listArtists())[0]!.cover).toMatchObject({ id: '1', rating: 'general' });
  await ds.updateImage('1', { rating: 'explicit' });
  // 封面全年龄优先：换成 2
  expect((await ds.listArtists())[0]!.cover).toMatchObject({ id: '2', rating: 'general' });
  await ds.updateImage('2', { rating: 'explicit' });
  expect((await ds.listArtists())[0]!.cover).toMatchObject({ id: '1', rating: 'explicit' });
  await ds.updateImage('1', { favorite: true });
  expect((await ds.listArtists())[0]).toMatchObject({ tag: 'kantoku', imageCount: 2 });
});

it('「识别画师」任务、Danbooru 同步直接写库（不声明变化）之后，不等缓存过期就是新的', async () => {
  const db = ds.ctx.db;
  const first = await ds.listArtists();
  // 待补的图（识别过、还没跑过画师）：任务在自己的事务里写，不经变更传播
  db.transaction(() => writeArtists(db, 4, [['mishima_kurone', 0.8]], 'y'))();
  const afterJob = await ds.listArtists();
  expect(afterJob).not.toBe(first);
  expect(afterJob.map((a) => [a.tag, a.imageCount])).toEqual([
    ['kantoku', 2],
    ['mishima_kurone', 2],
  ]);
  // 这张图没认出画师：只记上跑过，列表内容不变（重算一遍也还是一样）
  db.transaction(() => writeArtists(db, 5, [], 'y'))();
  expect((await ds.listArtists()).map((a) => [a.tag, a.imageCount])).toEqual(afterJob.map((a) => [a.tag, a.imageCount]));

  // 同步到画师资料：显示名、推特
  db.prepare(
    "INSERT INTO danbooru_artists (name, display, names, twitter, fetched_at) VALUES ('kantoku', 'カントク', '[]', 'kantoku_5th', '2026-11-01T00:00:00.000Z')",
  ).run();
  expect((await ds.listArtists())[0]).toMatchObject({ tag: 'kantoku', name: 'カントク', twitter: 'kantoku_5th' });
  // 过期后重新查了一遍，改了显示名
  db.prepare("UPDATE danbooru_artists SET display = 'かんとく', fetched_at = '2026-11-02T00:00:00.000Z' WHERE name = 'kantoku'").run();
  expect((await ds.listArtists())[0]).toMatchObject({ tag: 'kantoku', name: 'かんとく' });
  const settled = await ds.listArtists();
  expect(await ds.listArtists()).toBe(settled);
});
