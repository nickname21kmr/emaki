import type { Job } from '@emaki/shared';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { KeepAwake } from './keepAwake.ts';

const job = (id: string, status: Job['status']): Job => ({
  id,
  kind: 'tag',
  status,
  progress: 0,
  total: null,
  message: '',
  startedAt: null,
  finishedAt: null,
});

/** 假的守护进程：记下有没有被 kill */
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => boolean };
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    return true;
  };
  return c as unknown as ChildProcess & { killed: boolean };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('KeepAwake', () => {
  afterEach(() => vi.useRealTimers());

  it('有任务在跑就挡住休眠；全部结束后过了宽限期才放开；中途接力的任务不会让它先放开', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bus = new EventBus();
    const children: ReturnType<typeof fakeChild>[] = [];
    const awake = new KeepAwake(bus, { enabled: async () => true, graceMs: 1000, spawnInhibitor: () => (children.push(fakeChild()), children.at(-1)!) });

    bus.emit({ type: 'job', job: job('scan', 'running') });
    await vi.advanceTimersByTimeAsync(0);
    expect(awake.holding).toBe(true);
    bus.emit({ type: 'job', job: job('tag', 'running') });
    bus.emit({ type: 'job', job: job('scan', 'done') });
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(1); // 同一个守护进程

    bus.emit({ type: 'job', job: job('tag', 'done') });
    await vi.advanceTimersByTimeAsync(500);
    expect(awake.holding).toBe(true);
    bus.emit({ type: 'job', job: job('dedupe', 'running') }); // 宽限期内接力
    await vi.advanceTimersByTimeAsync(1000);
    expect(awake.holding).toBe(true);

    bus.emit({ type: 'job', job: job('dedupe', 'done') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(awake.holding).toBe(false);
    expect(children[0]!.killed).toBe(true);
    awake.close();
  });

  it('设置里关着就不挡；运行中关掉，下一次进度事件时放开', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bus = new EventBus();
    let on = false;
    const spawn = vi.fn(fakeChild);
    const awake = new KeepAwake(bus, { enabled: async () => on, spawnInhibitor: spawn });
    bus.emit({ type: 'job', job: job('tag', 'running') });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).not.toHaveBeenCalled();

    on = true;
    bus.emit({ type: 'job', job: job('tag2', 'running') });
    await vi.advanceTimersByTimeAsync(0);
    expect(awake.holding).toBe(true);

    on = false;
    await vi.advanceTimersByTimeAsync(11_000);
    bus.emit({ type: 'job', job: job('tag2', 'running') }); // 进度事件
    await vi.advanceTimersByTimeAsync(0);
    expect(awake.holding).toBe(false);
    awake.close();
  });

  it('守护进程自己退出了（例如被杀）→ 下一个任务重新起', async () => {
    const bus = new EventBus();
    const children: ReturnType<typeof fakeChild>[] = [];
    const awake = new KeepAwake(bus, { enabled: async () => true, spawnInhibitor: () => (children.push(fakeChild()), children.at(-1)!) });
    bus.emit({ type: 'job', job: job('a', 'running') });
    await flush();
    children[0]!.emit('exit', 1);
    expect(awake.holding).toBe(false);
    bus.emit({ type: 'job', job: job('b', 'running') });
    await flush();
    expect(children).toHaveLength(2);
    awake.close();
  });
});
