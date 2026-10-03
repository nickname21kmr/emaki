/**
 * 预处理线程池（host 子进程里用）。
 *
 * DirectML 的 session.run() 会把子进程的 JS 线程整个卡住一次推理的时间（PixAI 约 0.42 秒）。
 * 预处理（读文件、sharp 解码缩放、转成 float32）原来也在这个线程上，下一张图只能在两次推理之间的空档里开始，
 * 实测显卡只有约 62% 的时间在算，1.91 张/秒。挪进工作线程后显卡 99% 的时间在算，约 2.24 张/秒（RTX 3070 Laptop）。
 *
 * 出问题时只会变慢、不会失败：线程起不来、反复崩溃，就关掉线程池，交回主线程按原来的方式预处理；
 * 单个线程崩了，它手上的图交回主线程重做，并换一个新线程。
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { PreprocessResult } from './preprocess.ts';

export interface PreprocessRequest {
  id: number;
  repo: string;
  path: string;
}
export type PreprocessReply = { id: number } & PreprocessResult;

/** 线程崩了、线程池关了：这张图要交回主线程重做（不是图片本身的问题） */
export class PoolUnavailableError extends Error {}

/** 两个线程就够：PixAI 预处理一张约 45 ms，推理 420 ms；多开只会和缩略图任务抢 CPU */
export const defaultPoolSize = () => Math.max(1, Math.min(2, Math.floor(os.availableParallelism() / 4)));
/** 累计崩这么多次就不再用线程池 */
const MAX_CRASHES = 3;

interface Slot {
  worker: Worker;
  pending: Map<number, { resolve: (r: PreprocessReply) => void; reject: (e: Error) => void }>;
}

export class PreprocessPool {
  private slots: Slot[] = [];
  private seq = 0;
  private crashes = 0;
  private closed = false;

  constructor(
    private readonly size = defaultPoolSize(),
    private readonly log: (m: string) => void = () => {},
    /** 测试用：换成别的工作线程脚本 */
    private readonly entry: URL = new URL('./preprocessWorker.ts', import.meta.url),
  ) {
    for (let i = 0; i < size; i++) this.spawn();
  }

  get available(): boolean {
    return !this.closed && this.slots.length > 0;
  }

  private spawn(): void {
    let worker: Worker;
    try {
      // execArgv 默认继承本进程的：tsx 的 loader 会一起带进工作线程，.ts 能直接跑
      worker = new Worker(this.entry);
    } catch (err) {
      this.fail(`预处理线程起不来：${(err as Error).message}`);
      return;
    }
    const slot: Slot = { worker, pending: new Map() };
    worker.on('message', (r: PreprocessReply) => {
      const p = slot.pending.get(r.id);
      if (!p) return;
      slot.pending.delete(r.id);
      p.resolve(r);
    });
    const onDead = (why: string) => {
      if (!this.slots.includes(slot)) return;
      this.slots = this.slots.filter((s) => s !== slot);
      for (const p of slot.pending.values()) p.reject(new PoolUnavailableError(why));
      slot.pending.clear();
      if (this.closed) return;
      this.crashes++;
      this.log(`预处理线程退出（${why}），第 ${this.crashes} 次`);
      if (this.crashes >= MAX_CRASHES) this.fail('预处理线程反复退出，改回主线程预处理');
      else this.spawn();
    };
    worker.on('error', (err) => onDead(err.message));
    worker.on('exit', (code) => onDead(`退出码 ${code}`));
    this.slots.push(slot);
  }

  private fail(why: string): void {
    this.log(why);
    this.closed = true;
    for (const s of this.slots) {
      for (const p of s.pending.values()) p.reject(new PoolUnavailableError(why));
      void s.worker.terminate();
    }
    this.slots = [];
  }

  /** 交给手上活最少的线程；线程池不可用时 reject PoolUnavailableError */
  run(repo: string, path: string): Promise<PreprocessReply> {
    if (!this.available) return Promise.reject(new PoolUnavailableError('预处理线程池没开'));
    const slot = this.slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ id, repo, path } satisfies PreprocessRequest);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const slots = this.slots;
    this.slots = [];
    for (const s of slots) for (const p of s.pending.values()) p.reject(new PoolUnavailableError('线程池已关闭'));
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}
