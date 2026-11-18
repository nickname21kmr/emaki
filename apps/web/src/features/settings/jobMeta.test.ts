import type { Job } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { estimateRemaining, JOB_LABEL } from './jobMeta';

const job = (patch: Partial<Job>): Job => ({
  id: 'j',
  kind: 'tag',
  status: 'running',
  progress: 10,
  total: 100,
  message: '识别角色：10 / 100 · 剩余约 3 分钟',
  etaSeconds: null,
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
  ...patch,
});

describe('任务的剩余时间（附录 #38：结构化字段，不从消息里抠）', () => {
  it('任务报了 etaSeconds 就用它', () => expect(estimateRemaining(job({ etaSeconds: 95 }), 10_000)).toBe(95_000));
  it('没报的按平均速度估', () => expect(estimateRemaining(job({}), 10_000)).toBe(90_000));
  it('不在运行的不估', () => expect(estimateRemaining(job({ status: 'done', etaSeconds: 5 }), 10_000)).toBeNull());
  it('任务名只有一份（packages/shared）', () => expect(JOB_LABEL['danbooru-sync']).toBe('同步 Danbooru'));
});
