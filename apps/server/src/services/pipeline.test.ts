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

const ctx = (aborted = false, yielded = false): JobContext => {
  const c = new AbortController();
  if (aborted) c.abort();
  return { signal: c.signal, setTotal() {}, advance() {}, setMessage() {}, shouldYield: () => false, requeue() {}, yielded };
};

function setup(o: { scan?: ScanSummary; tagPending?: number; tagReady?: boolean; artists?: { enabled: boolean; pending: number; ready?: boolean }; danbooru?: boolean } = {}) {
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
    danbooru: o.danbooru === undefined ? undefined : { shouldRunAfterTag: () => o.danbooru, run: async () => '同步完成' },
  } as unknown as PipelineDeps;
  return { pipeline: new Pipeline(deps), enqueued, requeue };
}

describe('Pipeline', () => {
  it('显式导入直接续接缩略图、识别和查重，不再扫描；暂停的识别保持暂停',async()=>{
    const p=setup({tagPending:1});p.pipeline.afterImport();
    expect(p.enqueued).toEqual(['tag','thumbnail']);
    await p.pipeline.runner('thumbnail')(ctx());
    expect(p.enqueued).toContain('dedupe');expect(p.enqueued).not.toContain('scan');
    const paused=setup({tagPending:1});paused.pipeline.notePaused('tag');paused.pipeline.afterImport();
    expect(paused.enqueued).toEqual(['thumbnail']);
  });
  it('设置里打开时：首次模型识别完成后自动排 Pixiv 补充，取消时不排；重启已有待补记录可续跑', async () => {
    const p=setup();
    p.pipeline.register({pixiv:{enabled:()=>true,pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['pixiv-tags']);
    expect(p.requeue).toEqual(['pixiv-tags']);
    const cancelled=setup();
    cancelled.pipeline.register({pixiv:{enabled:()=>true,pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
    await cancelled.pipeline.runner('tag')(ctx(true));
    expect(cancelled.enqueued).toEqual([]);
    const restarted=setup();
    restarted.pipeline.register({pixiv:{enabled:()=>true,pendingCount:()=>2,run:async()=> 'Pixiv 完成'}});
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
    p.pipeline.register({pixiv:{enabled:()=>true,pendingCount:()=>2,run:async()=> {throw new Error('offline');}}});
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).rejects.toThrow('offline');
    await expect(p.pipeline.runner('tag')(ctx())).resolves.toBe('识别完成');
    expect(p.enqueued).toEqual([]);
    p.pipeline.noteManualStart('tag');
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['pixiv-tags']);
  });

  it('Pixiv：自动排上的那轮开跑时开关已经关了，就不联网；手动的照常跑', async () => {
    const p = setup();
    let on = true;
    let ran = 0;
    p.pipeline.register({ pixiv: { enabled: () => on, pendingCount: () => 2, run: async () => (ran++, 'Pixiv 完成') } });
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['pixiv-tags']);
    on = false;
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).resolves.toBe('补充 Pixiv 角色：设置里没有打开');
    expect(ran).toBe(0);
    p.pipeline.noteManualStart('pixiv-tags');
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).resolves.toBe('Pixiv 完成');
    expect(ran).toBe(1);
  });

  it('Pixiv：设置里没打开时识别完、扫描完都不自动排；手动点按钮照常跑', async () => {
    const p = setup();
    let ran = 0;
    p.pipeline.register({ pixiv: { enabled: () => false, pendingCount: () => 2, run: async () => (ran++, 'Pixiv 完成') } });
    await p.pipeline.runner('tag')(ctx());
    await p.pipeline.runner('scan')(ctx());
    expect(p.enqueued).toEqual([]);
    p.pipeline.noteManualStart('pixiv-tags');
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).resolves.toBe('Pixiv 完成');
    expect(ran).toBe(1);
  });

  it('Pixiv：识别完先排同步、查重，最后才排 Pixiv（免得它先占住 io 道）', async () => {
    const p = setup({ danbooru: true });
    p.pipeline.register({ pixiv: { enabled: () => true, pendingCount: () => 2, run: async () => 'Pixiv 完成' } });
    p.pipeline.markDedupeDirty();
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual(['danbooru-sync', 'dedupe', 'pixiv-tags']);
  });

  it('Pixiv：让出时不排 Danbooru 同步，续跑的那一轮跑完才排', async () => {
    const p = setup({ danbooru: true });
    p.pipeline.register({ pixiv: { enabled: () => true, pendingCount: () => 2, run: async () => 'Pixiv 完成' } });
    await p.pipeline.runner('pixiv-tags')(ctx(false, true));
    expect(p.enqueued).toEqual([]);
    await p.pipeline.runner('pixiv-tags')(ctx());
    expect(p.enqueued).toEqual(['danbooru-sync']);
  });

  it('Pixiv：手动开始的一轮（含让出后的续跑）记为手动；整轮跑完、或排队中被取消后清掉', async () => {
    const p = setup();
    p.pipeline.register({ pixiv: { enabled: () => false, pendingCount: () => 2, run: async () => 'Pixiv 完成' } });
    expect(p.pipeline.isPixivManual()).toBe(false);
    p.pipeline.noteManualStart('pixiv-tags');
    await p.pipeline.runner('pixiv-tags')(ctx(false, true));
    expect(p.pipeline.isPixivManual()).toBe(true);
    await p.pipeline.runner('pixiv-tags')(ctx());
    expect(p.pipeline.isPixivManual()).toBe(false);
    p.pipeline.noteManualStart('pixiv-tags');
    p.pipeline.notePaused('pixiv-tags');
    expect(p.pipeline.isPixivManual()).toBe(false);
  });

  it('Pixiv：设置里刚打开（requestPixiv）→ 清掉暂停和失败，有积压就排一轮；没积压、开关关着都不排', async () => {
    let on = true;
    let pending = 2;
    const p = setup();
    p.pipeline.register({ pixiv: { enabled: () => on, pendingCount: () => pending, run: async () => { throw new Error('offline'); } } });
    await expect(p.pipeline.runner('pixiv-tags')(ctx())).rejects.toThrow('offline');
    p.pipeline.notePaused('pixiv-tags');
    await p.pipeline.runner('tag')(ctx());
    expect(p.enqueued).toEqual([]);
    // 不带 requeueIfRunning：正在跑（手动点的）时不追加一轮
    p.pipeline.requestPixiv();
    expect([p.enqueued, p.requeue]).toEqual([['pixiv-tags'], []]);
    pending = 0;
    p.pipeline.requestPixiv();
    on = false;
    pending = 2;
    p.pipeline.requestPixiv();
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

  it('识别任务知道是不是用户手动点的（自动排上的不下载旧图模型）；手动标记只用一次', async () => {
    const { pipeline } = setup({ tagPending: 10 });
    const seen: (boolean | undefined)[] = [];
    pipeline.register({ tag: { isReady: () => true, pendingCount: () => 10, run: async (_c, o) => void seen.push(o?.manual) } });
    await pipeline.runner('tag')(ctx());
    pipeline.noteManualStart('tag');
    await pipeline.runner('tag')(ctx());
    await pipeline.runner('tag')(ctx());
    expect(seen).toEqual([false, true, false]);
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
