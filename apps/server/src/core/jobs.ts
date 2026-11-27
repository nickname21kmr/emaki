import { randomUUID } from 'node:crypto';
import type { Points } from './points.ts';
import { JOB_KINDS, JOB_LABEL as JOB_LABELS, jobTitle, type Job, type JobKind } from '@emaki/shared';
import type { EventBus } from './events.ts';
import { jobActor, runAs } from '../propagation/actor.ts';

/**
 * 一个后台任务的执行体。通过 ctx 汇报进度、检查取消。
 * 返回字符串 = 任务结束时显示的 message（例如扫描摘要）。
 * 真实实现见 services/*（扫描、缩略图、打标签、Danbooru 同步、查重）。
 */
export type JobRunner = (ctx: JobContext) => Promise<void | string>;

export interface JobContext {
  readonly signal: AbortSignal;
  /** 当前任务的 id（推 job-item 事件用；测试里的假 ctx 可以不给） */
  readonly jobId?: string;
  setTotal(total: number | null): void;
  /** 进度 +n，并可更新提示文字 */
  advance(n?: number, message?: string): void;
  setMessage(message: string): void;
  /** 预计还要多少秒（结构化，界面直接用；不知道传 null）。任务名和剩余时间的文案在 packages/shared（JOB_LABEL、formatEta） */
  setEta?(seconds: number | null): void;
  /** 有更高优先级的任务在排队：长任务应尽快 requeue() 然后 return */
  shouldYield(): boolean;
  /** 当前任务结束后再排一个同类任务 */
  requeue(): void;
  /** 本次调用过 requeue()（Pipeline 据此判断要不要链式触发） */
  readonly yielded: boolean;
}

/** 数字越小越先跑（任务种类的注册表 packages/shared/src/jobs.ts） */
const PRIORITY = (kind: JobKind): number => JOB_KINDS[kind].priority;

/** 已结束的任务最多保留这么多条（queued / running 永远不删） */
const KEEP_FINISHED = 100;

/**
 * 两条道（2026-09-28）：识别主要吃显卡，单独一条 gpu 道；扫描、缩略图、查重、同步吃 CPU / 硬盘，在 io 道里串行。
 * 两条道同时跑，所以缩略图不会再把识别堵在后面。插件的任务（E5，多是联网下载）再单开一条 plugin 道：
 * 下载着的时候新图的扫描、缩略图照常跑，长的扫描也不挡下载。每种任务在哪条道登记在任务种类的注册表里
 */
type Lane = (typeof JOB_KINDS)[JobKind]['lane'];
const LANE = (kind: JobKind): Lane => JOB_KINDS[kind].lane;

/**
 * 任务队列：每条道同一时间只跑一个任务，道内按优先级出队，同优先级先进先出。
 * 同一种任务已在排队时，再次提交直接返回已有的那个。
 */
export class JobQueue {
  private readonly jobs: Job[] = [];
  private readonly runners = new Map<string, JobRunner>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running: Record<Lane, boolean> = { io: false, gpu: false, plugin: false };
  /** 内部点（引擎的上下文建好以后接上，datasource/sqlite/context.ts）；单元测试里没有 */
  points: Points | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly resolveRunner: (kind: JobKind) => JobRunner,
    /**
     * 任务结束时（完成、让出、取消、失败都算）：变更传播做掉延后的全量重算、推 changed 事件（reason 是任务种类，附录 #20）。
     * 不给时直接推一条 changed 事件（单元测试）
     */
    private readonly onFinished?: (kind: JobKind) => void,
  ) {}

  usePoints(points: Points): void {
    this.points = points;
  }

  list(): Job[] {
    // 最新的在前，只返回最近 20 条
    return [...this.jobs].reverse().slice(0, 20);
  }

  /** requeueIfRunning：同类任务正在运行时，也再排一个（它结束后再跑一遍） */
  enqueue(kind: JobKind, opts: { requeueIfRunning?: boolean } = {}): Job {
    const queued = this.jobs.find((j) => j.kind === kind && j.status === 'queued');
    if (queued) return queued;
    const running = this.jobs.find((j) => j.kind === kind && j.status === 'running');
    if (running && !opts.requeueIfRunning) return running;

    const job: Job = {
      id: randomUUID(),
      kind,
      status: 'queued',
      progress: 0,
      total: null,
      message: `${JOB_LABELS[kind]}：等待中`,
      etaSeconds: null,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    // 执行体是内部点 job:<种类>（第 3 层插件能改）：跑的时候再套补丁，排队期间补丁变了也按跑的时候的
    const runner = this.resolveRunner(kind);
    this.runners.set(job.id, (ctx) => (this.points ? this.points.wrap(`job:${kind}`, runner) : runner)(ctx));
    this.trim();
    this.publish(job);
    void this.pump();
    return job;
  }

  /**
   * 插件的任务（kind 是 plugin，docs/plugins.md 第 6 节）：名字是插件登记的，执行体直接给（在插件的子进程里跑）。
   * 每次都是一个新任务，不和别的合并；排队、通道、进度、取消都和内置的一样
   */
  enqueueTask(o: { title: string; plugin: string; run: JobRunner }): Job {
    const job: Job = {
      id: randomUUID(),
      kind: 'plugin',
      title: o.title,
      plugin: o.plugin,
      status: 'queued',
      progress: 0,
      total: null,
      message: `${o.title}：等待中`,
      etaSeconds: null,
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    this.runners.set(job.id, o.run);
    this.trim();
    this.publish(job);
    void this.pump();
    return job;
  }

  /** 一个任务现在的样子（插件查自己的任务） */
  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !JOB_KINDS[job.kind].cancellable) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.runners.delete(job.id);
      this.publish(job);
    }
    this.controllers.get(id)?.abort();
  }

  private trim(): void {
    const finished = this.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)));
    if (!drop.size) return;
    for (let i = this.jobs.length - 1; i >= 0; i--) if (drop.has(this.jobs[i]!)) this.jobs.splice(i, 1);
  }

  /** 这条道里优先级最高的；同优先级按先进先出 */
  private pickNext(lane: Lane): Job | undefined {
    let best: Job | undefined;
    for (const j of this.jobs) {
      if (j.status !== 'queued' || LANE(j.kind) !== lane) continue;
      if (!best || PRIORITY(j.kind) < PRIORITY(best.kind)) best = j;
    }
    return best;
  }

  private async pump(): Promise<void> {
    void this.pumpLane('io');
    void this.pumpLane('gpu');
    void this.pumpLane('plugin');
  }

  private async pumpLane(lane: Lane): Promise<void> {
    if (this.running[lane]) return;
    const job = this.pickNext(lane);
    if (!job) return;
    this.running[lane] = true;

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = `${jobTitle(job)}：进行中`;
    this.publish(job);

    let yielded = false;
    const ctx: JobContext = {
      signal: controller.signal,
      jobId: job.id,
      setTotal: (total) => {
        job.total = total;
        this.publish(job);
      },
      advance: (n = 1, message) => {
        job.progress += n;
        if (message) job.message = message;
        this.publishThrottled(job);
      },
      setMessage: (message) => {
        job.message = message;
        this.publishThrottled(job);
      },
      setEta: (seconds) => {
        job.etaSeconds = seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
      },
      // 只让给同一条道里更急的任务（另一条道本来就在并行跑）
      shouldYield: () => this.jobs.some((j) => j.status === 'queued' && LANE(j.kind) === lane && PRIORITY(j.kind) < PRIORITY(job.kind)),
      requeue: () => {
        yielded = true;
        this.enqueue(job.kind, { requeueIfRunning: true });
      },
      get yielded() {
        return yielded;
      },
    };

    try {
      // 执行体里的写操作都记在 job:<任务种类> 名下（弱刷新、事件节流）；不继承排队时那个请求的 actor
      const run = this.runners.get(job.id)!;
      const result = await runAs(jobActor(job.kind), () => run(ctx));
      job.status = controller.signal.aborted ? 'cancelled' : 'done';
      job.message =
        typeof result === 'string' && job.status === 'done'
          ? result
          : `${jobTitle(job)}：${job.status === 'done' ? (yielded ? '已让出，稍后继续' : '完成') : '已取消'}`;
    } catch (err) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      // 取消时抛出的（下载被中断「This operation was aborted」之类）不算失败
      job.message =
        job.status === 'cancelled'
          ? `${jobTitle(job)}：已取消`
          : `${jobTitle(job)}失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      job.finishedAt = new Date().toISOString();
      job.etaSeconds = null;
      this.controllers.delete(job.id);
      this.runners.delete(job.id);
      this.publish(job);
      if (this.onFinished) this.onFinished(job.kind);
      else this.bus.publish({ type: 'changed', changes: [], reason: job.kind, actor: `job:${job.kind}` });
      this.running[lane] = false;
      void this.pump();
    }
  }

  // 按任务各自节流：两条道同时跑时互不吞掉对方的进度
  private readonly lastPublish = new Map<string, number>();
  private publishThrottled(job: Job): void {
    const now = performance.now();
    if (now - (this.lastPublish.get(job.id) ?? 0) < 150) return;
    this.lastPublish.set(job.id, now);
    if (this.lastPublish.size > 50) this.lastPublish.clear();
    this.publish(job);
  }

  private publish(job: Job): void {
    this.bus.emit({ type: 'job', job: { ...job } });
  }
}
