import { afterEach, expect, it, vi } from 'vitest';
import type { JobKind } from '@emaki/shared';
import type { JobContext, JobQueue } from '../core/jobs.ts';
import { Pipeline, type PipelineDeps } from './pipeline.ts';
import { ScanRequests } from './scan/ScanRequests.ts';
import type { ScanSummary } from './scan/Scanner.ts';

afterEach(() => vi.useRealTimers());

const ctx = (): JobContext => ({
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
});

it('有延后的文件：过 3 秒再扫一次；这期间请求已经被别的扫描取走了就不排（空请求会变成全量扫描）', async () => {
  vi.useFakeTimers();
  const requests = new ScanRequests();
  const enqueued: JobKind[] = [];
  const jobs = { enqueue: (k: JobKind) => void enqueued.push(k) } as unknown as JobQueue;
  const summary: ScanSummary = { added: 0, updated: 0, moved: 0, missing: 0, restored: 0, errors: 0, deferred: 1, unreachable: [], newIds: [] };
  const pipeline = new Pipeline({
    jobs: () => jobs,
    requests,
    scanner: { scan: async () => summary },
    thumbs: { runBackfill: async () => '' },
    pixelPendingCount: () => 0,
  } as unknown as PipelineDeps);
  // 扫描器把延后文件所在的目录记回 requests
  const deferredScan = async () => {
    requests.addDirty({ rootId: 1, relDir: 'Downloads', recursive: false });
    await pipeline.runner('scan')(ctx());
  };

  await deferredScan();
  await vi.advanceTimersByTimeAsync(3000);
  expect(enqueued).toEqual(['scan']);
  requests.take();

  await deferredScan();
  requests.take(); // 监听又触发了一次扫描，先把这个目录扫了
  await vi.advanceTimersByTimeAsync(3000);
  expect(enqueued).toEqual(['scan']);
});
