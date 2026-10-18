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

function setup(o: { scan?: ScanSummary; tagPending?: number; tagReady?: boolean; artists?: { enabled: boolean; pending: number; ready?: boolean } } = {}) {
  const enqueued: JobKind[] = [];
  const requeue: JobKind[] = [];
  const jobs = {
    enqueue: (k: JobKind, opts?: { requeueIfRunning?: boolean }) => {
      enqueued.push(k);
      if (opts?.requeueIfRunning) requeue.push(k);
    },
  } as unknown as JobQueue;
  const deps = {
    jobs: () => jobs,
    requests: {},
    scanner: { scan: async () => o.scan ?? summary() },
    thumbs: { runBackfill: async () => '缩略图完成' },
    pixelPendingCount: () => 0,
    tag: { isReady: () => o.tagReady ?? true, pendingCount: () => o.tagPending ?? 0, run: async () => '识别完成' },
    artists: o.artists && { enabled: () => o.artists!.enabled, isReady: () => o.artists!.ready ?? true, pendingCount: () => o.artists!.pending, run: async () => '画师完成' },
  } as unknown as PipelineDeps;
  return { pipeline: new Pipeline(deps), enqueued, requeue };
}

describe('Pipeline', () => {
  it('content filtering is opt-in, resumes after tags, and pauses queued work on failure/cancel', async () => {
    const p = setup();
    let enabled = false, ready = true, fail = false, calls = 0, retries = 0;
    p.pipeline.register({ content: {
      enabled: () => enabled, isReady: () => ready, pendingCount: () => 3,
      retryErrors: () => { retries++; }, stop: async () => {},
      run: async () => { calls++; if (fail) throw new Error('GPU failed'); return 'done'; },
    } });
    await p.pipeline.runner('tag')(ctx()); expect(p.enqueued).toEqual([]);
    enabled = true; ready = false;
    await p.pipeline.runner('tag')(ctx()); expect(p.enqueued).toEqual([]);
    ready = true;
    await p.pipeline.runner('tag')(ctx()); expect(p.enqueued).toEqual(['content-filter']);
    fail = true;
    await expect(p.pipeline.runner('content-filter')(ctx())).rejects.toThrow('GPU failed');
    await p.pipeline.runner('tag')(ctx());
    await p.pipeline.runner('content-filter')(ctx());
    expect(calls).toBe(1); expect(p.enqueued).toHaveLength(1);
    p.pipeline.noteManualStart('content-filter'); fail = false;
    await p.pipeline.runner('content-filter')(ctx());
    expect(retries).toBe(1); expect(calls).toBe(2);
    p.pipeline.notePaused('content-filter');
    await p.pipeline.runner('content-filter')(ctx());
    await p.pipeline.runner('tag')(ctx());
    expect(calls).toBe(2); expect(p.enqueued).toHaveLength(1);
  });
  it('首次模型识别完成后自动排 Pixiv 补充，取消时不排；重启已有待补记录可续跑', async () => {
    const p=setup();
    p.pipeline.register({pixiv:{pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['pixiv-tags']);
    expect(p.requeue).toEqual(['pixiv-tags']);
    const cancelled=setup();
    cancelled.pipeline.register({pixiv:{pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
    await cancelled.pipeline.runner('tag')(ctx(true));
    expect(cancelled.enqueued).toEqual([]);
    const restarted=setup();
    restarted.pipeline.register({pixiv:{pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
    await restarted.pipeline.runner('scan')(ctx());
    expect(restarted.enqueued).toEqual(['pixiv-tags']);
    restarted.pipeline.notePaused('pixiv-tags');
    await restarted.pipeline.runner('tag')(ctx());
    expect(restarted.enqueued).toEqual(['pixiv-tags']);
    restarted.pipeline.noteManualStart('pixiv-tags');
    await restarted.pipeline.runner('tag')(ctx());
    expect(restarted.enqueued).toEqual(['pixiv-tags','pixiv-tags']);
  });

  it('Pixiv 网络失败暂停自动重试，模型识别结果不受影响', async () => {
    const p=setup();
    p.pipeline.register({pixiv:{pendingCount:()=>2,run:async()=> {throw new Error('offline');}}});
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).rejects.toThrow('offline');
    await expect(p.pipeline.runner('tag')(ctx())).resolves.toBe('识别完成');
    expect(p.enqueued).toEqual([]);
    p.pipeline.noteManualStart('tag');
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['pixiv-tags']);
  });
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

  it('画师：开着、没补完 → 重启后接着补（没有要识别的时直接排）；关着不排；取消后不自动续，手动后恢复', async () => {
    const on = setup({ tagPending: 0, artists: { enabled: true, pending: 500 } });
    await on.pipeline.runner('scan')(ctx());
    expect(on.enqueued).toEqual(['artists']);

    const off = setup({ tagPending: 0, artists: { enabled: false, pending: 500 } });
    await off.pipeline.runner('scan')(ctx());
    expect(off.enqueued).toEqual([]);

    const p = setup({ tagPending: 0, artists: { enabled: true, pending: 500 } });
    await p.pipeline.runner('artists')(ctx(true));
    await p.pipeline.runner('scan')(ctx());
    expect(p.enqueued).toEqual([]);
    p.pipeline.noteManualStart('artists');
    await p.pipeline.runner('scan')(ctx());
    expect(p.enqueued).toEqual(['artists']);
  });

  it('画师：有要识别的图时先识别，识别完再接着补', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 10, artists: { enabled: true, pending: 500 } });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual(['tag']);
    await pipeline.runner('tag')(ctx());
    expect(enqueued).toEqual(['tag', 'artists']);
  });

  it('画师：排队中被取消（runner 没执行）也记暂停，识别完不再排', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 10, artists: { enabled: true, pending: 500 } });
    pipeline.notePaused('artists');
    await pipeline.runner('tag')(ctx());
    expect(enqueued).toEqual([]);
  });

  it('画师：识别被用户暂停、还有没识别的图时不接手显卡', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 10, artists: { enabled: true, pending: 500 } });
    await pipeline.runner('tag')(ctx(true)); // 取消识别
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual([]);
  });

  it('画师：模型没下载时不自动续补', async () => {
    const { pipeline, enqueued } = setup({ tagPending: 0, artists: { enabled: true, pending: 500, ready: false } });
    await pipeline.runner('scan')(ctx());
    expect(enqueued).toEqual([]);
  });

  it('画师改回自动（requestArtists）：能续补时排一轮（正在跑也再排）；关着、模型不在、用户暂停过都不排', async () => {
    const on = setup({ artists: { enabled: true, pending: 3 } });
    on.pipeline.requestArtists();
    expect([on.enqueued, on.requeue]).toEqual([['artists'], ['artists']]);

    for (const artists of [{ enabled: false, pending: 3 }, { enabled: true, pending: 3, ready: false }, { enabled: true, pending: 0 }]) {
      const p = setup({ artists });
      p.pipeline.requestArtists();
      expect(p.enqueued).toEqual([]);
    }

    const paused = setup({ artists: { enabled: true, pending: 3 } });
    paused.pipeline.notePaused('artists');
    paused.pipeline.requestArtists();
    expect(paused.enqueued).toEqual([]);
  });
});
