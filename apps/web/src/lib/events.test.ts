import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvalidator, openEventStream } from './events';

interface Call {
  predicate: (q: { queryKey: readonly unknown[] }) => boolean;
  refetchType?: string;
}

function fakeClient() {
  const calls: Call[] = [];
  const client = {
    invalidateQueries: (f: Call) => {
      calls.push(f);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, calls };
}

/** 排名列表（作品）真的重拉了几次；只标记过期（refetchType: 'none'）的不算 */
const rankRefetches = (calls: Call[]) => calls.filter((c) => c.refetchType !== 'none' && c.predicate({ queryKey: ['works', {}] })).length;

describe('createInvalidator：识别中排名列表的节流', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 从现在起每 5 秒来一次 tag 事件，共 n 次（每次都等 400ms 的节流跑完） */
  const tagEvery5s = (invalidate: (r?: 'tag') => void, n: number) => {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(4600);
      invalidate('tag');
      vi.advanceTimersByTime(400);
    }
  };

  it('识别 40 秒后没有新事件：一分钟到了补拉一次，之后不再拉', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    expect(rankRefetches(calls)).toBe(1);
    tagEvery5s(invalidate, 8);
    expect(rankRefetches(calls)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(rankRefetches(calls)).toBe(2);
    vi.advanceTimersByTime(10 * 60_000);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('最后一次事件离窗口到期很近时，至少再等 11 秒（躲过后端的软缓存）', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 11); // 最后一次在第 55.4 秒处理完，窗口第 60.4 秒到期
    vi.advanceTimersByTime(10_999);
    expect(rankRefetches(calls)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('非识别事件照常立刻刷新，待补的那次取消', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 1);
    invalidate('mutation');
    vi.advanceTimersByTime(400);
    expect(rankRefetches(calls)).toBe(2);
    vi.advanceTimersByTime(5 * 60_000);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('dispose 后不再补拉', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 2);
    dispose();
    vi.advanceTimersByTime(5 * 60_000);
    expect(rankRefetches(calls)).toBe(1);
  });
});

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSource.all.push(this);
  }
  close() {
    this.readyState = 2;
  }
  /** 代理回了 502：EventSource 直接关掉，不会自己重连 */
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

describe('openEventStream：断了自己重连', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = () => {
    const on = { open: vi.fn(), message: vi.fn(), error: vi.fn() };
    const close = openEventStream(on, () => new FakeSource() as unknown as EventSource);
    return { on, close };
  };
  const last = () => FakeSource.all.at(-1)!;

  it('收到 502 关掉后退避重建，连上后退避时间复位', () => {
    const { on, close } = open();
    last().onopen?.();
    expect(on.open).toHaveBeenCalledTimes(1);
    last().onmessage?.({ data: '{"type":"stats"}' });
    expect(on.message).toHaveBeenCalledWith('{"type":"stats"}');

    last().fail();
    expect(on.error).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(2);

    // 后端还没起来：再失败一次，这回等 2 秒
    last().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(3);

    // 连上了：onopen 再跑一次（重置任务表、刷新），下次断开又从 1 秒开始
    last().onopen?.();
    expect(on.open).toHaveBeenCalledTimes(2);
    last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(4);
    close();
  });

  it('还在 CONNECTING 的错误交给浏览器自己重连', () => {
    const { close } = open();
    last().onerror?.();
    vi.advanceTimersByTime(30_000);
    expect(FakeSource.all).toHaveLength(1);
    close();
  });

  it('卸载后不再重连', () => {
    const { close } = open();
    last().fail();
    close();
    vi.advanceTimersByTime(30_000);
    expect(FakeSource.all).toHaveLength(1);
  });
});
