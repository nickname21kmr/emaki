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
});
