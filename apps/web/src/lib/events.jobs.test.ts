import type { Job } from '@emaki/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { isJobRunning, useLiveJobs } from './events';

const job = (over: Partial<Job>): Job => ({
  id: 'j1',
  kind: 'tag',
  status: 'running',
  progress: 0,
  total: 100,
  message: '',
  etaSeconds: null,
  startedAt: '2026-11-28T00:00:00Z',
  finishedAt: null,
  ...over,
});

describe('isJobRunning：只看有没有在跑（useIsJobRunning 的选择器）', () => {
  beforeEach(() => useLiveJobs.getState().reset([]));

  it('同一个任务连着推进度：值一直是 true（布尔值不变，订阅它的组件不重渲染）；任务结束变 false', () => {
    const seen: boolean[] = [];
    const read = () => isJobRunning(useLiveJobs.getState().jobs, 'tag');
    expect(read()).toBe(false);
    // 每条进度事件都换一个 Job 对象（useRunningJob 因此每次都变），这里的值不变
    for (let p = 10; p <= 50; p += 10) {
      useLiveJobs.getState().upsert(job({ progress: p }));
      seen.push(read());
    }
    expect(seen).toEqual([true, true, true, true, true]);
    useLiveJobs.getState().upsert(job({ status: 'done', progress: 100, finishedAt: '2026-11-28T00:01:00Z' }));
    expect(read()).toBe(false);
  });

  it('按种类分开：识别在跑不算查重在跑；排队的、取消的不算', () => {
    const { upsert } = useLiveJobs.getState();
    upsert(job({ id: 'a', kind: 'tag' }));
    upsert(job({ id: 'b', kind: 'dedupe', status: 'queued' }));
    upsert(job({ id: 'c', kind: 'scan', status: 'cancelled' }));
    const jobs = useLiveJobs.getState().jobs;
    expect(isJobRunning(jobs, 'tag')).toBe(true);
    expect(isJobRunning(jobs, 'dedupe')).toBe(false);
    expect(isJobRunning(jobs, 'scan')).toBe(false);
    expect(isJobRunning(jobs, 'thumbnail')).toBe(false);
  });
});
