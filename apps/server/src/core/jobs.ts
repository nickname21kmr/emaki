import { randomUUID } from 'node:crypto';
import type { Job, JobKind } from '@emaki/shared';
import type { EventBus } from './events.ts';

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
  /** 有更高优先级的任务在排队：长任务应尽快 requeue() 然后 return */
  shouldYield(): boolean;
  /** 当前任务结束后再排一个同类任务 */
  requeue(): void;
  /** 本次调用过 requeue()（Pipeline 据此判断要不要链式触发） */
  readonly yielded: boolean;
}

const JOB_LABELS: Record<JobKind, string> = {
  scan: '扫描图库',
  thumbnail: '生成缩略图',
  tag: '识别角色',
  'danbooru-sync': '同步 Danbooru',
  dedupe: '查找重复',
};

/** 数字越小越先跑：新放进来的图要先扫描、出缩略图，别被一个多小时的打标签堵住 */
const PRIORITY: Record<JobKind, number> = { scan: 0, thumbnail: 1, dedupe: 2, tag: 3, 'danbooru-sync': 4 };

/** 已结束的任务最多保留这么多条（queued / running 永远不删） */
const KEEP_FINISHED = 100;

/**
 * 两条道（2026-09-28）：识别主要吃显卡，单独一条 gpu 道；扫描、缩略图、查重、同步吃 CPU / 硬盘，在 io 道里串行。
 * 两条道同时跑，所以缩略图不会再把识别堵在后面。
 */
const LANE: Record<JobKind, 'io' | 'gpu'> = { scan: 'io', thumbnail: 'io', dedupe: 'io', tag: 'gpu', 'danbooru-sync': 'io' };

/**
 * 任务队列：每条道同一时间只跑一个任务，道内按优先级出队，同优先级先进先出。
 * 同一种任务已在排队时，再次提交直接返回已有的那个。
 */
export class JobQueue {
  private readonly jobs: Job[] = [];
  private readonly runners = new Map<string, JobRunner>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = { io: false, gpu: false };

  constructor(
    private readonly bus: EventBus,
    private readonly resolveRunner: (kind: JobKind) => JobRunner,
  ) {}

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
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    this.runners.set(job.id, this.resolveRunner(kind));
    this.trim();
    this.publish(job);
    void this.pump();
    return job;
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
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
  private pickNext(lane: 'io' | 'gpu'): Job | undefined {
    let best: Job | undefined;
    for (const j of this.jobs) {
      if (j.status !== 'queued' || LANE[j.kind] !== lane) continue;
      if (!best || PRIORITY[j.kind] < PRIORITY[best.kind]) best = j;
    }
    return best;
  }

  private async pump(): Promise<void> {
    void this.pumpLane('io');
    void this.pumpLane('gpu');
  }

  private async pumpLane(lane: 'io' | 'gpu'): Promise<void> {
    if (this.running[lane]) return;
    const job = this.pickNext(lane);
    if (!job) return;
    this.running[lane] = true;

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = `${JOB_LABELS[job.kind]}：进行中`;
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
      // 只让给同一条道里更急的任务（另一条道本来就在并行跑）
      shouldYield: () => this.jobs.some((j) => j.status === 'queued' && LANE[j.kind] === lane && PRIORITY[j.kind] < PRIORITY[job.kind]),
      requeue: () => {
        yielded = true;
        this.enqueue(job.kind, { requeueIfRunning: true });
      },
      get yielded() {
        return yielded;
      },
    };

    try {
      const result = await this.runners.get(job.id)!(ctx);
      job.status = controller.signal.aborted ? 'cancelled' : 'done';
      job.message =
        typeof result === 'string' && job.status === 'done'
          ? result
          : `${JOB_LABELS[job.kind]}：${job.status === 'done' ? (yielded ? '已让出，稍后继续' : '完成') : '已取消'}`;
    } catch (err) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.message = `${JOB_LABELS[job.kind]}失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id);
      this.runners.delete(job.id);
      this.publish(job);
      this.bus.emit({ type: 'library-changed', reason: job.kind === 'tag' ? 'tag' : 'scan' });
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
