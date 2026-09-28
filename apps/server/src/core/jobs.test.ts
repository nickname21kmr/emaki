import type { Job, JobKind } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from './events.ts';
import { JobQueue, type JobContext, type JobRunner } from './jobs.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

/** 可控的假 runner：每个任务启动后挂起，等测试手动 release */
function harness() {
  const order: JobKind[] = [];
  const pending = new Map<JobKind, { ctx: JobContext; release: (v?: string) => void }>();
  const runner =
    (kind: JobKind): JobRunner =>
    (ctx) =>
      new Promise<string | void>((resolve) => {
        order.push(kind);
        pending.set(kind, { ctx, release: resolve });
        ctx.signal.addEventListener('abort', () => resolve());
      });
  const q = new JobQueue(new EventBus(), runner);
  const finish = async (kind: JobKind, result?: string) => {
    pending.get(kind)!.release(result);
    pending.delete(kind);
    await tick();
  };
  return { q, order, pending, finish };
}

const byKind = (q: JobQueue, kind: JobKind): Job => q.list().find((j) => j.kind === kind)!;

describe('JobQueue', () => {
  it('两条道：识别单独一条，和 io 道并行；io 道内按优先级出队 scan → dedupe', async () => {
    const { q, order, finish } = harness();
    q.enqueue('danbooru-sync'); // 占住 io 道
    await tick();
    q.enqueue('dedupe');
    q.enqueue('scan');
    q.enqueue('tag'); // gpu 道空着，马上开始
    await tick();
    expect(order).toEqual(['danbooru-sync', 'tag']);
    await finish('danbooru-sync');
    await finish('scan');
    await finish('dedupe');
    await finish('tag');
    expect(order).toEqual(['danbooru-sync', 'tag', 'scan', 'dedupe']);
  });

  it('同类任务排队时返回同一个；运行中带 requeueIfRunning 会再排一个', async () => {
    const { q } = harness();
    const a = q.enqueue('scan');
    await tick();
    expect(q.enqueue('scan').id).toBe(a.id); // 运行中，不带参数 → 同一个
    const b = q.enqueue('scan', { requeueIfRunning: true });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('queued');
    expect(q.enqueue('scan', { requeueIfRunning: true }).id).toBe(b.id); // 已有排队的 → 同一个
  });

  it('长任务只让给同一条道里更急的任务，之后自动继续', async () => {
    const { q, order, pending, finish } = harness();
    q.enqueue('dedupe');
    q.enqueue('tag');
    await tick();
    const dedupe = pending.get('dedupe')!;
    const tag = pending.get('tag')!;
    expect(dedupe.ctx.shouldYield()).toBe(false);
    q.enqueue('scan');
    expect(dedupe.ctx.shouldYield()).toBe(true);
    expect(tag.ctx.shouldYield()).toBe(false); // 识别在另一条道，不用让
    dedupe.ctx.requeue();
    await finish('dedupe');
    await finish('scan');
    await finish('dedupe');
    await finish('tag');
    expect(order).toEqual(['dedupe', 'tag', 'scan', 'dedupe']);
  });

  it('runner 返回的字符串作为最终 message', async () => {
    const { q, finish } = harness();
    q.enqueue('scan');
    await tick();
    await finish('scan', '扫描完成：新增 3');
    expect(byKind(q, 'scan')).toMatchObject({ status: 'done', message: '扫描完成：新增 3' });
  });

  it('取消运行中的任务', async () => {
    const { q } = harness();
    const job = q.enqueue('scan');
    await tick();
    q.cancel(job.id);
    await tick();
    expect(byKind(q, 'scan').status).toBe('cancelled');
  });
});
