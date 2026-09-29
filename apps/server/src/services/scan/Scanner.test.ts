import { rmSync } from 'node:fs';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { EventBus } from '../../core/events.ts';
import type { JobContext } from '../../core/jobs.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { walkImages } from '../fs/walk.ts';
import { sharp } from '../image/sharpConfig.ts';
import { Scanner, type ScanSummary } from './Scanner.ts';
import { ScanRequests } from './ScanRequests.ts';

const ctx = (): JobContext => ({
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
});

const png = (seed: number) =>
  sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 100, b: 200 - seed * 10 } } })
    .png()
    .toBuffer();

describe('Scanner', () => {
  let root: string;
  let data: string;
  let db: Db;
  let requests: ScanRequests;
  const scanner = (settleMs = 0) => new Scanner({ db, bus: new EventBus(), dataDir: data, requests, settleMs });
  const scan = (settleMs = 0): Promise<ScanSummary> => scanner(settleMs).scan(ctx());
  const put = async (rel: string, seed: number) => {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), await png(seed));
  };
  const row = (fileName: string) =>
    db.prepare('SELECT id, rel_path, sha256, missing FROM images WHERE file_name = ?').get(fileName) as
      | { id: number; rel_path: string; sha256: string; missing: number }
      | undefined;

  beforeEach(async () => {
    root = makeTmpDir('scan-root');
    data = makeTmpDir('scan-data');
    db = openDatabase(':memory:');
    migrate(db);
    requests = new ScanRequests();
    db.prepare('INSERT INTO library_roots (path) VALUES (?)').run(root.replace(/\\/g, '/'));
    await put('a/one.png', 1);
    await put('a/two.png', 2);
    await put('b/three.png', 3);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('新增', async () => {
    const s = await scan();
    expect(s).toMatchObject({ added: 3, missing: 0, errors: 0 });
    expect((await scan()).added).toBe(0);
  });

  it('整根扫描（新添加文件夹）更新上次扫描时间，子目录扫描不更新', async () => {
    const last = () => db.prepare('SELECT last_scan_at FROM library_roots').pluck().get();
    requests.addDirty({ rootId: 1, relDir: 'a', recursive: true });
    await scan();
    expect(last()).toBeNull();
    requests.addDirty({ rootId: 1, relDir: '', recursive: true });
    await scan();
    expect(last()).not.toBeNull();
  });

  it('移动后 id 不变', async () => {
    await scan();
    const before = row('one.png')!;
    await rename(path.join(root, 'a/one.png'), path.join(root, 'b/one.png'));
    expect((await scan()).moved).toBe(1);
    expect(row('one.png')).toMatchObject({ id: before.id, rel_path: 'b/one.png', missing: 0 });
  });

  it('改名 + 删除原文件：按 sha 认出是同一张', async () => {
    await scan();
    const before = row('two.png')!;
    await rename(path.join(root, 'a/two.png'), path.join(root, 'a/renamed.png'));
    expect((await scan()).moved).toBe(1);
    expect(row('renamed.png')?.id).toBe(before.id);
  });

  it('删除 → missing，放回 → 恢复', async () => {
    await scan();
    const buf = await png(3);
    await rm(path.join(root, 'b/three.png'));
    expect((await scan()).missing).toBe(1);
    expect(row('three.png')?.missing).toBe(1);
    await writeFile(path.join(root, 'b/three.png'), buf);
    await scan();
    expect(row('three.png')?.missing).toBe(0);
  });

  it('遍历时漏掉了、其实还在的文件（移动硬盘中途断开又接上）不标丢失；真删掉的照常标', async () => {
    await scan();
    await rm(path.join(root, 'b/three.png'));
    // 遍历时 one.png 读不到（没有报目录错误），实际文件还在
    const flaky: typeof walkImages = async function* (rootPath, o) {
      for await (const e of walkImages(rootPath, o)) if (!e.relPath.endsWith('one.png')) yield e;
    };
    const s = await new Scanner({ db, bus: new EventBus(), dataDir: data, requests, settleMs: 0, walk: flaky }).scan(ctx());
    expect(s.missing).toBe(1);
    expect(row('one.png')?.missing).toBe(0);
    expect(row('three.png')?.missing).toBe(1);
  });

  it('改内容后 id 不变但 sha 变了', async () => {
    await scan();
    const before = row('one.png')!;
    const file = path.join(root, 'a/one.png');
    await writeFile(file, await png(9));
    const t = new Date(Date.now() + 10_000); // 保证 mtime 一定变化
    await utimes(file, t, t);
    expect((await scan()).updated).toBe(1);
    const after = row('one.png')!;
    expect(after.id).toBe(before.id);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('刚写入的文件延后处理', async () => {
    // 刚写的文件修改时间偶尔会比 Date.now() 晚几毫秒（文件系统取整），会被当成「时钟不同步」不延后；固定成 1 秒前
    const t = new Date(Date.now() - 1000);
    for (const rel of ['a/one.png', 'a/two.png', 'b/three.png']) await utimes(path.join(root, rel), t, t);
    const s = await scan(60_000);
    expect(s.deferred).toBe(3);
    expect(s.added).toBe(0);
    expect(requests.pending).toBe(true);
  });

  it('读不了的文件记进 scan_errors，不重复报错', async () => {
    await writeFile(path.join(root, 'a/fake.png'), '不是图片');
    expect((await scan()).errors).toBe(1);
    expect((await scan()).errors).toBe(0);
    expect(db.prepare('SELECT count(*) FROM scan_errors').pluck().get()).toBe(1);
  });
});
