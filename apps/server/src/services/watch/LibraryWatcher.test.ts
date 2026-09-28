import { rmSync } from 'node:fs';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { isoFromMs } from '../fs/paths.ts';
import { ScanRequests } from '../scan/ScanRequests.ts';
import { LibraryWatcher } from './LibraryWatcher.ts';

async function waitFor(fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('LibraryWatcher（真实目录）', () => {
  let root: string;
  let requests: ScanRequests;
  let watcher: LibraryWatcher;
  let scans: number;
  const taken: ReturnType<ScanRequests['take']>[] = [];

  beforeEach(() => {
    root = makeTmpDir('watch');
    requests = new ScanRequests();
    scans = 0;
    taken.length = 0;
    watcher = new LibraryWatcher({
      requests,
      enqueueScan: () => {
        scans++;
        taken.push(requests.take());
      },
      dataDir: path.join(root, '..', 'no-such-data'),
      log: () => {},
      quietMs: 100,
      rescanMinutes: 0,
    });
    watcher.sync([{ id: 1, path: root.replace(/\\/g, '/'), enabled: true }]);
  });
  afterEach(async () => {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  });

  const scopes = () => taken.flatMap((t) => t.scopes);

  it('新图片 → 它所在目录（非递归）', async () => {
    // 先建目录并等它的事件消化掉（同一个防抖窗口里新建目录会合并成递归扫描，那也是对的）
    await mkdir(path.join(root, 'a'));
    await new Promise((r) => setTimeout(r, 400));
    taken.length = 0;
    await writeFile(path.join(root, 'a', 'b.png'), 'x');
    await waitFor(() => scopes().some((s) => s.relDir === 'a' && !s.recursive));
  });

  it('新目录 → 递归扫描这个目录', async () => {
    await mkdir(path.join(root, 'c'));
    await writeFile(path.join(root, 'c', 'd.txt'), 'x');
    await waitFor(() => scopes().some((s) => s.relDir === 'c' && s.recursive));
  });

  it('根目录被删除不会让进程崩溃', async () => {
    await rm(root, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(true).toBe(true);
  });
});

describe('防抖', () => {
  afterEach(() => vi.useRealTimers());

  it('安静期内的一串事件只触发一次扫描', async () => {
    vi.useFakeTimers();
    const requests = new ScanRequests();
    const enqueueScan = vi.fn();
    const w = new LibraryWatcher({ requests, enqueueScan, dataDir: 'Z:/nowhere', log: () => {}, quietMs: 1500, rescanMinutes: 0 });
    const root = { id: 1, path: 'Z:/lib', enabled: true };
    // 直接调私有的事件处理，模拟 50 个文件
    const onEvent = (w as unknown as { onEvent: (r: typeof root, f: string) => void }).onEvent.bind(w);
    for (let i = 0; i < 50; i++) {
      onEvent(root, `drop\\f${i}.png`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueueScan).toHaveBeenCalledTimes(1);
    expect(requests.take().scopes).toEqual([{ rootId: 1, relDir: 'drop', recursive: false }]);
    await w.close();
  });

  it('持续有事件时最多等 maxWaitMs', async () => {
    vi.useFakeTimers();
    const enqueueScan = vi.fn();
    const w = new LibraryWatcher({ requests: new ScanRequests(), enqueueScan, dataDir: 'Z:/x', log: () => {}, quietMs: 1500, maxWaitMs: 3000, rescanMinutes: 0 });
    const onEvent = (w as unknown as { onEvent: (r: object, f: string) => void }).onEvent.bind(w);
    for (let i = 0; i < 40; i++) {
      onEvent({ id: 1, path: 'Z:/lib', enabled: true }, `a\\${i}.png`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(enqueueScan.mock.calls.length).toBeGreaterThanOrEqual(1);
    await w.close();
  });
});

describe('LibraryWatcher：只改属性不扫描', () => {
  let root: string;
  let requests: ScanRequests;
  let watcher: LibraryWatcher;
  let scans: number;
  const known = new Map<string, { bytes: number; modified_at: string }>();

  beforeEach(async () => {
    root = makeTmpDir('watch-known');
    requests = new ScanRequests();
    scans = 0;
    known.clear();
    await writeFile(path.join(root, 'a.png'), 'x');
    const st = await stat(path.join(root, 'a.png'));
    known.set('a.png', { bytes: st.size, modified_at: isoFromMs(st.mtimeMs) });
    watcher = new LibraryWatcher({
      requests,
      enqueueScan: () => {
        scans++;
        requests.take();
      },
      dataDir: path.join(root, '..', 'no-such-data'),
      log: () => {},
      quietMs: 100,
      rescanMinutes: 0,
      known: (_rootId, rel) => known.get(rel),
    });
    watcher.sync([{ id: 1, path: root.replace(/\\/g, '/'), enabled: true }]);
    await new Promise((r) => setTimeout(r, 300));
    scans = 0;
  });
  afterEach(async () => {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('大小和修改时间都没变（只动了访问时间 / 属性）→ 不触发扫描', async () => {
    const file = path.join(root, 'a.png');
    const st = await stat(file);
    // 传秒数（带小数）而不是 Date：Date 只有毫秒精度，会把修改时间四舍五入改掉
    await utimes(file, (Date.now() - 3_600_000) / 1000, st.mtimeMs / 1000);
    await new Promise((r) => setTimeout(r, 600));
    expect(scans).toBe(0);
  });

  it('内容变了 → 触发扫描', async () => {
    await writeFile(path.join(root, 'a.png'), 'changed');
    await waitFor(() => scans > 0);
  });
});
