import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../core/events.ts';
import type { JobContext } from '../../../core/jobs.ts';
import { SqliteDataSource } from '../../../datasource/sqlite/SqliteDataSource.ts';
import { makeTmpDir } from '../../../../test/helpers/tmp.ts';
import { artistPendingCount, createArtistJobRunner, writeArtists } from '../artists.ts';
import type { TaggerLike } from '../client.ts';
import type { HostItemResult, HostThresholds } from '../protocol.ts';
import { resetIoBackoff } from '../readBackoff.ts';

describe('画师', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const add = (id: number, kind = 'illustration') =>
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, rating)
         VALUES (?, 1, ?, ?, 100, 140, 1, 'png', ?, 'x', 'x', ?, 'general')`,
      )
      .run(id, `${id}.png`, `${id}.png`, `s${id}`, kind);

  beforeEach(async () => {
    dir = makeTmpDir('artists');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
    for (const id of [1, 2, 3, 4]) add(id);
    add(5, 'screenshot');
    ds.ctx.invalidate();
    resetIoBackoff();
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('列出画师（按张数）、按画师筛图；认不出的不在里面', async () => {
    ds.ctx.db.transaction(() => {
      writeArtists(ds.ctx.db, 1, [['kantoku', 0.98]], 'x');
      writeArtists(ds.ctx.db, 2, [['kantoku', 0.6]], 'x');
      writeArtists(ds.ctx.db, 3, [['mishima_kurone', 0.9]], 'x');
      writeArtists(ds.ctx.db, 4, [], 'x');
    })();
    ds.ctx.invalidate();
    const list = await ds.listArtists();
    expect(list.map((a) => [a.tag, a.name, a.imageCount, a.cover?.id])).toEqual([
      ['kantoku', 'kantoku', 2, '1'],
      ['mishima_kurone', 'mishima kurone', 1, '3'],
    ]);
    expect((await ds.listImages({ artist: 'kantoku' })).items.map((i) => i.id).sort()).toEqual(['1', '2']);

    // 同步过 Danbooru：用日文名；社团名被认成了另一个画师的，并到本人
    ds.ctx.db.transaction(() => {
      writeArtists(ds.ctx.db, 4, [['afterschool_of_the_5th_year', 0.7]], 'x');
      ds.ctx.db
        .prepare("INSERT INTO danbooru_artists (name, display, names, twitter, fetched_at) VALUES ('kantoku', 'カントク', '[\"5年目の放課後\",\"afterschool_of_the_5th_year\"]', 'kantoku_5th', 'x')")
        .run();
    })();
    ds.ctx.invalidate();
    const merged = await ds.listArtists();
    expect(merged[0]).toMatchObject({ tag: 'kantoku', name: 'カントク', imageCount: 3, twitter: 'kantoku_5th' });
    expect(merged[0]!.tags.sort()).toEqual(['afterschool_of_the_5th_year', 'kantoku']);
    expect(merged[0]!.aliases).toContain('5年目の放課後');
    expect((await ds.listImages({ artist: 'kantoku' })).items.map((i) => i.id).sort()).toEqual(['1', '2', '4']);
    // 跑过的不再待补；截图不补
    expect(artistPendingCount(ds.ctx.db)).toBe(0);
  });

  it('补跑任务：只写画师，读不到的也标跑过', async () => {
    const calls: HostThresholds[] = [];
    const fake: TaggerLike = {
      device: 'dml',
      batchSize: 2,
      info: { pid: 1, dmlDeviceId: 0, fallbackReason: null } as TaggerLike['info'],
      async tag(items, th) {
        calls.push(th);
        return items.map((it): HostItemResult =>
          it.id === 2
            ? { id: it.id, ok: false, code: 'DECODE', message: 'bad' }
            : { id: it.id, ok: true, rating: null, general: [], character: [], artist: it.id === 1 ? [['ama_mitsuki', 0.99]] : [] },
        );
      },
    } as TaggerLike;
    const run = createArtistJobRunner({
      db: ds.ctx.db,
      modelsDir: 'X:/models',
      getDevice: () => ({ device: 'dml', batchSize: 2 }),
      clientFactory: async () => fake,
      ensureFiles: (async () => ({ dir: 'X', modelPath: 'X/m', labelsPath: 'X/l' })) as never,
    });
    const ctx = {
      signal: new AbortController().signal,
      setTotal() {},
      advance() {},
      setMessage() {},
      shouldYield: () => false,
      requeue() {},
      yielded: false,
    } as unknown as JobContext;
    expect(artistPendingCount(ds.ctx.db)).toBe(4);
    const msg = await run(ctx);
    expect(msg).toBe('识别画师：补了 4 张，认出画师 1 张');
    expect(calls[0]).toMatchObject({ general: 2, character: 2, artist: 0.35 });
    expect(artistPendingCount(ds.ctx.db)).toBe(0);
    expect(ds.ctx.db.prepare('SELECT artist FROM image_artists').pluck().all()).toEqual(['ama_mitsuki']);
    // 没有动角色和标签
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM image_tags').pluck().get()).toBe(0);
  });

  it('读不了的图：这次不标跑过，退避期间不算待补（自动续补不会为它反复加载模型）；连续 3 次读不了才标跑过', async () => {
    let calls = 0;
    const fake = {
      device: 'dml',
      batchSize: 2,
      info: { pid: 1, dmlDeviceId: 0, fallbackReason: null },
      async tag(items: { id: number }[]) {
        calls++;
        return items.map((it): HostItemResult =>
          it.id === 3
            ? { id: it.id, ok: false, code: 'IO', message: 'EBUSY' }
            : it.id === 4
              ? { id: it.id, ok: false, code: 'ENOENT', message: 'gone' }
              : { id: it.id, ok: true, rating: null, general: [], character: [], artist: [] },
        );
      },
    } as unknown as TaggerLike;
    const run = createArtistJobRunner({
      db: ds.ctx.db,
      modelsDir: 'X:/models',
      getDevice: () => ({ device: 'dml', batchSize: 2 }),
      clientFactory: async () => fake,
      ensureFiles: (async () => ({ dir: 'X', modelPath: 'X/m', labelsPath: 'X/l' })) as never,
    });
    const ctx = {
      signal: new AbortController().signal,
      setTotal() {},
      advance() {},
      setMessage() {},
      shouldYield: () => false,
      requeue() {},
      yielded: false,
    } as unknown as JobContext;
    const checked = () => ds.ctx.db.prepare('SELECT id FROM images WHERE artist_checked_at IS NOT NULL ORDER BY id').pluck().all();

    await run(ctx);
    expect(checked()).toEqual([1, 2]);
    // 3 和 4 还没补，但在退避：不算待补，再跑也不会加载模型
    expect(artistPendingCount(ds.ctx.db)).toBe(0);
    calls = 0;
    expect(await run(ctx)).toBe('识别画师：没有需要补的图');
    expect(calls).toBe(0);

    // 用户手动点（清掉退避）：再试；3 第三次还是读不了就标跑过，4（文件不在）留给扫描器
    resetIoBackoff();
    await run(ctx);
    resetIoBackoff();
    await run(ctx);
    expect(checked()).toEqual([1, 2, 3]);
    expect(artistPendingCount(ds.ctx.db)).toBe(0);
    resetIoBackoff();
    expect(artistPendingCount(ds.ctx.db)).toBe(1);
  });
});
