import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { MutationResult } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../../services/image/sharpConfig.ts';
import { diskCaseRel } from './roots.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

describe('图库文件夹重新启用时扫描、手动扫描不被吞', () => {
  let dir: string;
  let lib: string;
  let ds: SqliteDataSource;
  const idle = async () => {
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
  };
  const put = async (name: string, seed: number) => {
    const p = path.join(lib, name);
    await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 90, b: 150 } } }).png().toFile(p);
    const old = new Date('2025-01-01'); // 刚写的文件会被延后处理
    utimesSync(p, old, old);
  };
  const images = () => ds.ctx.db.prepare('SELECT file_name, missing FROM images ORDER BY file_name').all();
  const rootId = async () => (await ds.getSettings()).libraryRoots[0]!.id;
  /** 文件夹不在监听里的这段时间：新增 b.png、删掉 a.png */
  const changeWhileOff = async () => {
    await put('b.png', 2);
    rmSync(path.join(lib, 'a.png'));
  };
  const synced = [
    { file_name: 'a.png', missing: 1 },
    { file_name: 'b.png', missing: 0 },
  ];

  beforeEach(async () => {
    dir = makeTmpDir('root-scan');
    lib = path.join(dir, 'lib');
    mkdirSync(lib);
    // autoJobs: false 不开监听，正好模拟「停用期间监听器收不到」
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    await put('a.png', 1);
    await ds.addLibraryRoot({ path: lib.replace(/\\/g, '/') });
    await idle();
    expect(images()).toEqual([{ file_name: 'a.png', missing: 0 }]);
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('停用期间的变化：重新启用时扫进来', async () => {
    await ds.updateLibraryRoot(await rootId(), { enabled: false });
    await changeWhileOff();
    await ds.updateLibraryRoot(await rootId(), { enabled: true });
    await idle();
    expect(images()).toEqual(synced);
  });

  it('撤销停用、撤销移除也一样', async () => {
    const off = await ds.updateLibraryRoot(await rootId(), { enabled: false });
    await changeWhileOff();
    await ds.undo(off.undoToken!);
    await idle();
    expect(images()).toEqual(synced);

    const removed: MutationResult = await ds.removeLibraryRoot(await rootId());
    await put('c.png', 3);
    await ds.undo(removed.undoToken!);
    await idle();
    expect(images()).toEqual([...synced, { file_name: 'c.png', missing: 0 }]);
  });

  it('手动扫描时正在跑别的扫描：再排一次，不被吞掉', async () => {
    const lib2 = path.join(dir, 'lib2');
    mkdirSync(lib2);
    await ds.addLibraryRoot({ path: lib2.replace(/\\/g, '/') }); // 只扫这个新文件夹的扫描开始跑了
    const running = (await ds.listJobs()).find((j) => j.kind === 'scan' && j.status === 'running');
    expect(running).toBeTruthy();
    const job = await ds.startJob('scan');
    expect(job.id).not.toBe(running!.id);
    expect(job.status).toBe('queued');
    await idle();
    expect((await ds.listJobs()).filter((j) => j.kind === 'scan' && j.status === 'done')).toHaveLength(3);
  });
});

it('diskCaseRel：换成磁盘上的大小写，找不到的段原样保留；可以共用读目录的缓存', async () => {
  const root = makeTmpDir('disk-case');
  try {
    mkdirSync(path.join(root, 'Pixiv', 'Sub'), { recursive: true });
    const r = root.replace(/\\/g, '/');
    const cache = new Map<string, Promise<string[]>>();
    expect(await diskCaseRel(r, 'pixiv/sub', cache)).toBe('Pixiv/Sub');
    expect(await diskCaseRel(r, 'pixiv/none/x.png', cache)).toBe('Pixiv/none/x.png');
    expect(await diskCaseRel(`${r}/`, 'PIXIV')).toBe('Pixiv');
    expect(cache.size).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
