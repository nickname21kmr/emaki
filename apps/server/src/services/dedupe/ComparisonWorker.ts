import { Worker } from 'node:worker_threads';
import type { ImageComparison } from './compareImages.ts';

export class ComparisonWorkerError extends Error {}

/** One serial worker keeps image comparisons off the HTTP thread and bounds decoded-image memory. */
export class ComparisonWorker {
  private readonly worker = new Worker(new URL('./comparisonWorker.mjs', import.meta.url));
  private pending: { resolve: (r: ImageComparison) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor() {
    this.worker.on('message', (r: { result?: ImageComparison; error?: string }) => {
      const p = this.pending;
      this.pending = null;
      if (r.result) p?.resolve(r.result);
      else p?.reject(new Error(r.error ?? '图片比较失败'));
    });
    this.worker.on('error', (e) => this.fail(new ComparisonWorkerError(e.message)));
    this.worker.on('exit', (code) => this.fail(new ComparisonWorkerError(`图片比较线程已退出（${code}）`)));
  }

  private fail(error: Error) {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = null;
  }

  compare = (a: string, b: string): Promise<ImageComparison> => {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('图片比较线程正在使用'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage([a, b]);
    });
  };

  async close() {
    this.fail(new Error('图片比较已结束'));
    await this.worker.terminate();
  }
}
