import { describe, expect, it } from 'vitest';
import type { JobKind } from '@emaki/shared';
import type { JobContext, JobQueue } from '../core/jobs.ts';
import { Pipeline, type PipelineDeps } from './pipeline.ts';
import type { ScanSummary } from './scan/Scanner.ts';

const summary = (o: Partial<ScanSummary> = {}): ScanSummary => ({
  added: 0,
  updated: 0,
  moved: 0,
  missing: 0,
  restored: 0,
  errors: 0,
  deferred: 0,
  unreachable: [],
  newIds: [],
  ...o,
});

const ctx = (aborted = false): JobContext => {
  const c = new AbortController();
  if (aborted) c.abort();
  return { signal: c.signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded: false };
};

function setup(o: { scan?: ScanSummary; tagPending?: number; tagReady?: boolean } = {}) {
  const enqueued: JobKind[] = [];
  const jobs = { enqueue: (k: JobKind) => enqueued.push(k) } as unknown as JobQueue;
  const deps = {
    jobs: () => jobs,
    requests: {},
    scanner: { scan: async () => o.scan ?? summary() },
    thumbs: { runBackfill: async () => '缩略图完成' },
    pixelPendingCount: () => 0,
    tag: { isReady: () => o.tagReady ?? true, pendingCount: () => o.tagPending ?? 0, run: async () => '识别完成' },
  } as unknown as PipelineDeps;
  return { pipeline: new Pipeline(deps), enqueued };
}

describe('Pipeline', () => {
  it('扫描没有新图，但还有没识别的图（例如进程重启丢了跑到一半的识别）→ 接着识别', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 15000 });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual(['tag']);
  });

  it('扫描没有新图、全部识别过 → 什么都不排', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 0 });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual([]);
  });

  it('有新图 → 识别和缩略图同时排上（两条道并行）；缩略图完成后补查重', async () => {
    const { pipeline, enqueued } = setup({ scan: summary({ added: 3 }), tagPending: 3 });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual(['tag', 'thumbnail']);
    await pipeline.runner('thumbnail')(ctx());
    expect(enqueued).toEqual(['tag', 'thumbnail', 'dedupe', 'tag']); // 真实队列里第二个 tag 会并到已有的那个
  });

  it('模型没下载时不自动识别', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 10, tagReady: false });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual([]);
  });

  it('用户取消识别后不自动续跑；手动开始后恢复', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 10 });
    await pipeline.runner('tag')(ctx(true));
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual([]);
    pipeline.noteManualStart('tag');
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual(['tag']);
  });
});
