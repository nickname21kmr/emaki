/**
 * 识别子进程出问题时怎么办（识别任务和画师补跑共用）：崩溃 / 超时 / 显卡出错的区分、重开、降级、隔离坏图。
 * 从 tagJob.ts 拆出来，免得 artists.ts 和 tagJob.ts 互相 import。
 */
import { TaggerCrashedError, type TaggerLike, type TaggerStartOptions } from './client.ts';
import { findModel } from './models.ts';
import type { HostItemResult, HostThresholds } from './protocol.ts';

/**
 * 显卡出问题（子进程没崩，但这次推理报错，显卡上的会话也废了）：
 * DXGI_ERROR_DEVICE_REMOVED / HUNG / RESET（0x887A0005–7）、TDR（0x887A0020）、DML 读回失败、WebGPU 设备丢失、显存不够（0x8007000E）
 */
const GPU_LOST = /887A000[5-7]|887A0020|8007000E|E_OUTOFMEMORY|out of memory|failed to allocate|readback failed|device (?:hung|removed|lost|reset)/i;
const isGpuLost = (err: unknown) => err instanceof Error && GPU_LOST.test(err.message);

/** 同设备重开的次数上限（时间窗内），超过就当显卡不稳定，往下降级 */
const RESTART_LIMIT = 3;
const RESTART_WINDOW = 30 * 60_000;
/** 子进程崩溃后，接下来这么多个请求一个一个发：只有一个在途时崩了，才能确定是哪张图的问题 */
const ISOLATE_REQUESTS = 8;
/** 一个请求最多重试几次（防止死循环） */
const MAX_TRIES = 6;

/**
 * 识别客户端出问题时的处理：
 * - 显卡问题（GPU_LOST）：一批多张的先改成一张一批；还不行、模型能走 WebGPU（PixAI）就换 WebGPU；最后换 CPU。
 * - 子进程崩溃 / 请求超时（TaggerCrashedError，不是显卡报错）：多半不是显卡坏了（一张坏图、休眠唤醒后的超时），
 *   先按原样重开；正常运行时 30 分钟内崩到第 3 次才按显卡问题降级。
 * - 崩溃后接下来的请求一个一个发（隔离），这样崩了就知道是谁。单独发连崩两次、而且有证据显卡是好的
 *   （中间别的请求成功了，或者拿识别成功过的图试一下成功了），就认定是这批图的问题：多张的拆开重试，单张的记成识别失败跳过。
 * - 多个在途请求同时失败时只做一次决定（generation + switching），其余的等它做完再重试。
 * - 任务结束或取消后（close / signal）不再重开子进程。
 */
export class ResilientTagger {
  private generation = 0;
  private switching: Promise<void> | null = null;
  private opts: TaggerStartOptions;
  /** 降级到 CPU 时的批大小按最初的设置算（一张一批是给显卡卡死用的） */
  private readonly initialBatch: number;
  private shrunk = false;
  private toWebgpu = false;
  private fellBack = false;
  private restarts: number[] = [];
  private isolate = 0;
  private okCount = 0;
  /** 最近一张识别成功的图，用来试显卡是不是好的 */
  private lastGood: { id: number; path: string } | null = null;
  private gate: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly onSwitch: (c: TaggerLike) => void;
  private readonly log: (m: string) => void;
  private readonly signal?: AbortSignal;
  /** 这一轮已经结束后才起好的客户端怎么处理（正式环境交给 releaseTagger：空闲 60 秒后关；别的任务要用会直接接着用） */
  private readonly discard: (c: TaggerLike) => void;
  private readonly now: () => number;

  constructor(
    private client: TaggerLike,
    opts: TaggerStartOptions,
    private readonly factory: (o: TaggerStartOptions) => Promise<TaggerLike>,
    o: {
      onSwitch?: (c: TaggerLike) => void;
      log?: (m: string) => void;
      signal?: AbortSignal;
      discard?: (c: TaggerLike) => void;
      now?: () => number;
    } = {},
  ) {
    this.onSwitch = o.onSwitch ?? (() => {});
    this.log = o.log ?? (() => {});
    this.signal = o.signal;
    this.discard = o.discard ?? (() => {});
    this.now = o.now ?? (() => Date.now());
    this.initialBatch = opts.batchSize;
    this.opts = this.adopt(opts, client);
  }

  /**
   * 客户端实际用上的设置：子进程里 DirectML 起不来时会自己回退到 WebGPU / CPU（启动时、重开时都可能），
   * 记下来，之后按原样重开时直接用能用的那个，别再去试已经失败过的
   */
  private adopt(opts: TaggerStartOptions, c: TaggerLike): TaggerStartOptions {
    if (c.device === 'cpu' && opts.device !== 'cpu') {
      this.fellBack = true;
      return { ...opts, device: 'cpu', noDml: false, batchSize: c.batchSize };
    }
    if (c.device === 'webgpu' && findModel(opts.repo)?.gpu === 'dml' && !opts.noDml) {
      this.toWebgpu = true;
      return { ...opts, noDml: true };
    }
    return opts;
  }

  get current(): TaggerLike {
    return this.client;
  }

  /** 这一轮结束（完成、取消、出错）：之后不再重开子进程，还在重试的请求直接失败 */
  close(): void {
    this.closed = true;
  }

  private checkOpen(): void {
    if (this.closed || this.signal?.aborted) throw new Error('识别已停止');
  }

  /** 一次只放一个请求进去 */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.gate;
    let release!: () => void;
    this.gate = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  tag(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]> {
    return this.run(items, th);
  }

  private async run(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]> {
    /** 这个请求上次单独发崩溃时，全局成功了多少个请求 */
    let okAtCrash: number | null = null;
    for (let tries = 0; ; tries++) {
      this.checkOpen();
      const alone = this.isolate > 0;
      const step = async () => {
        if (this.switching) await this.switching;
        this.checkOpen();
        // 在真正发出去之前才取代数：失败时据此判断「是不是当前这个子进程出的事」
        const gen = this.generation;
        try {
          return { ok: true as const, res: await this.client.tag(items, th) };
        } catch (err) {
          const lost = isGpuLost(err);
          if (!(err instanceof TaggerCrashedError || lost)) throw err;
          const crashedAlone = alone && !lost;
          // 单独发崩了两次，而这中间有别的请求正常跑完：显卡是好的，是这批图本身有问题
          // （显卡要是坏了，别的请求也会崩，不会有成功的，也就不会误判）
          const poison = crashedAlone && okAtCrash !== null && this.okCount > okAtCrash;
          // 单独发连崩两次、中间没有任何请求成功过（比如它是最后一批）：还分不清是图的问题还是显卡的问题
          const unsure = crashedAlone && okAtCrash !== null && this.okCount === okAtCrash;
          if (crashedAlone) okAtCrash = this.okCount;
          // 隔离排查时的重开不算进「显卡不稳定」的次数（显卡坏没坏由 probe 判断）；
          // 还没有识别成功过的图可以拿来试（一开始显卡就是坏的），那就照常计数，到次数就降级。
          // recover 的同步部分在这里就把 switching 设好：交还隔离队列之后，下一个请求会等重开，不会撞上已经退出的子进程
          const rec = this.recover(gen, err, lost, !alone || (unsure && !this.lastGood));
          rec.catch(() => undefined);
          return { ok: false as const, err, rec, poison, unsure, crashedAlone };
        }
      };
      const r = alone ? await this.exclusive(step) : await step();
      if (r.ok) {
        this.okCount++;
        const good = r.res.find((x) => x.ok);
        if (good) this.lastGood = items.find((it) => it.id === good.id) ?? this.lastGood;
        if (alone) this.isolate = Math.max(0, this.isolate - 1);
        return r.res;
      }
      await r.rec;
      if (r.poison) return this.skip(items, th, r.err);
      if (tries + 1 >= MAX_TRIES) {
        // 重试到头：单独发也一直崩，而且别的图能识别、或者换到 CPU 上也照样崩（和显卡无关），就把这一张记成失败，不让整个任务失败
        if (r.crashedAlone && items.length === 1 && (this.okCount > 0 || this.client.device === 'cpu')) return this.skip(items, th, r.err);
        throw r.err;
      }
      if (r.unsure) {
        // 多张的拆开：好图会成功，问题图再崩就能认出来
        if (items.length > 1) return this.split(items, th);
        // 单张的：拿之前识别成功过的一张图试一下，成功说明显卡没问题，下次它再崩就认定是这张图
        await this.probe(th);
      }
    }
  }

  /** 拆成一张一张重试，都排进隔离队列 */
  private async split(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]> {
    this.isolate = Math.max(this.isolate, items.length + 1);
    return (await Promise.all(items.map((it) => this.run([it], th)))).flat();
  }

  /** 用之前识别成功过的图试一下显卡；结果丢掉，只为确认「别的图能跑」。试的时候又崩了就按正常流程重开 / 降级 */
  private async probe(th: HostThresholds): Promise<void> {
    const good = this.lastGood;
    if (!good) return;
    const rec = await this.exclusive(async () => {
      if (this.switching) await this.switching;
      this.checkOpen();
      const gen = this.generation;
      try {
        await this.client.tag([good], th);
        this.okCount++;
        return null;
      } catch (err) {
        const lost = isGpuLost(err);
        if (!(err instanceof TaggerCrashedError || lost)) throw err;
        // 识别成功过的图也崩：算显卡问题
        const p = this.recover(gen, err, lost, true);
        p.catch(() => undefined);
        return p;
      }
    });
    if (rec) await rec;
  }

  /** 认定会弄崩子进程的图：多张的拆开各自重试（排在别的图后面），单张的记成识别失败 */
  private async skip(items: { id: number; path: string }[], th: HostThresholds, err: unknown): Promise<HostItemResult[]> {
    if (items.length > 1) return this.split(items, th);
    // 这几次崩溃是这张图引起的，不算显卡不稳定
    this.restarts = [];
    const why = (err as Error).message;
    this.log(`跳过一张会让识别子进程崩溃的图（id ${items[0]!.id}）：${why}`);
    return items.map((it) => ({ id: it.id, ok: false, code: 'DECODE', message: `识别时子进程崩溃，已跳过（${why}）` }));
  }

  /**
   * 换一个客户端。同一代只决定一次，其余失败的请求等它换好后重试。count：这次崩溃算不算进「显卡不稳定」的次数。
   * 同步部分（判断、设 switching）在调用时立刻执行完。
   */
  private async recover(gen: number, err: unknown, lost: boolean, count: boolean): Promise<void> {
    if (gen !== this.generation) return; // 已经换过了：这次失败是旧子进程的，直接重试
    if (!this.switching) {
      this.checkOpen();
      const next = this.decide(err, lost, count);
      this.switching = this.factory(next)
        .then((c) => {
          // 这一轮已经结束：不接管新客户端
          if (this.closed) return this.discard(c);
          this.opts = this.adopt(next, c);
          this.client = c;
          this.generation++;
          this.onSwitch(c);
        })
        .finally(() => {
          this.switching = null;
        });
    }
    await this.switching;
  }

  private decide(err: unknown, lost: boolean, count: boolean): TaggerStartOptions {
    const msg = (err as Error).message;
    // 已经在 CPU 上了没有可降级的、或者是隔离排查时的崩溃：按原样重开（同一个请求最多重试 MAX_TRIES 次）
    if (!lost && (this.client.device === 'cpu' || !count)) {
      this.isolate = ISOLATE_REQUESTS;
      this.log(`识别子进程异常（${msg}），按原设置重开`);
      return this.opts;
    }
    if (!lost) {
      const t = this.now();
      this.restarts = this.restarts.filter((x) => t - x < RESTART_WINDOW);
      if (this.restarts.length < RESTART_LIMIT) {
        this.restarts.push(t);
        this.isolate = ISOLATE_REQUESTS;
        this.log(`识别子进程异常（${msg}），按原设置重开`);
        return this.opts;
      }
      this.log(`识别子进程 30 分钟内异常 ${RESTART_LIMIT} 次，按显卡问题处理`);
    }
    if (this.client.device === 'cpu' || this.fellBack) throw err;
    if (lost && !this.shrunk && this.client.batchSize > 1) {
      this.shrunk = true;
      this.log(`显卡出错（${msg}），改成一张一批`);
      return { ...this.opts, batchSize: 1 };
    }
    if (!this.toWebgpu && this.client.device === 'dml' && !!findModel(this.opts.repo)?.webgpuFallback) {
      this.toWebgpu = true;
      this.log(`显卡出错（${msg}），改用 WebGPU`);
      return { ...this.opts, noDml: true };
    }
    this.fellBack = true;
    this.log(`显卡出错（${msg}），改用 CPU`);
    return { ...this.opts, device: 'cpu', noDml: false, batchSize: Math.min(this.initialBatch, 4) };
  }
}

