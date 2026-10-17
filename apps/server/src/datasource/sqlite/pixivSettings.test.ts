import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import type { JobContext } from '../../core/jobs.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

// 不联网：把 Pixiv 补充换成一直跑到被取消的假任务，待查数量由测试控制
const fake = vi.hoisted(() => ({ pending: 0, runs: 0 }));
vi.mock('../../services/pixiv/sync.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/pixiv/sync.ts')>()),
  pendingPixivCount: () => fake.pending,
  queuePixivImages: () => {},
  syncPixivCharacters: (_ctx: unknown, job: JobContext) => {
    fake.runs++;
    return new Promise<string>((resolve) => job.signal.addEventListener('abort', () => resolve('已取消')));
  },
}));

describe('设置：识别后自动查 Pixiv 标签', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const pixivJobs = async () => (await ds.listJobs()).filter((j) => j.kind === 'pixiv-tags').map((j) => j.status);

  beforeEach(async () => {
    fake.pending = 0;
    fake.runs = 0;
    dir = makeTmpDir('pixiv-settings');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  });
  afterEach(async () => {
    for (const j of await ds.listJobs()) if (j.status === 'queued' || j.status === 'running') await ds.cancelJob(j.id);
    await vi.waitFor(async () => expect((await ds.listJobs()).some((j) => j.status === 'running')).toBe(false));
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认关；打开时有积压就排一轮，关掉时停掉自动排上的', async () => {
    expect((await ds.getSettings()).tagger.pixiv).toBe(false);
    // 没有积压：打开不排
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual([]);
    await ds.updateSettings({ tagger: { pixiv: false } });

    fake.pending = 3;
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual(['running']);
    expect(fake.runs).toBe(1);
    await ds.updateSettings({ tagger: { pixiv: false } });
    await vi.waitFor(async () => expect(await pixivJobs()).toEqual(['cancelled']));
    expect((await ds.getSettings()).tagger.pixiv).toBe(false);
  });

  it('关着时手动点按钮照常跑；跑的时候关掉设置也不取消它', async () => {
    fake.pending = 3;
    await ds.startJob('pixiv-tags');
    expect(await pixivJobs()).toEqual(['running']);
    // 跑着时打开设置不追加一轮；再关掉也不取消手动点的这一轮
    await ds.updateSettings({ tagger: { pixiv: true } });
    expect(await pixivJobs()).toEqual(['running']);
    await ds.updateSettings({ tagger: { pixiv: false } });
    expect(await pixivJobs()).toEqual(['running']);
    expect(fake.runs).toBe(1);
  });
});
