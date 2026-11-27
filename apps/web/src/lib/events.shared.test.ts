import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSharedEventStream, type SharedStreamDeps } from './events';

/** 假的 EventSource：手动 open、发消息 */
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
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.onmessage?.({ data });
  }
}
const live = () => FakeSource.all.filter((s) => s.readyState !== 2);

/** 假的 Web Locks（只有一把锁）：排队、signal 撤掉排队、steal 抢走（被抢的那次 request 的 promise 被拒） */
function fakeLocks() {
  type Req = { cb: () => Promise<void>; resolve: () => void; reject: (e: Error) => void };
  let held: Req | null = null;
  const queue: Req[] = [];
  const grant = (r: Req) => {
    held = r;
    void r.cb().then(() => {
      if (held !== r) return;
      held = null;
      r.resolve();
      const next = queue.shift();
      if (next) grant(next);
    });
  };
  return {
    request: (_name: string, opts: { steal?: boolean; signal?: AbortSignal }, cb: () => Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        const r: Req = { cb, resolve, reject };
        if (opts.steal) {
          const old = held;
          held = null;
          old?.reject(new DOMException('stolen', 'AbortError'));
          return grant(r);
        }
        opts.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(r);
          if (i >= 0) (queue.splice(i, 1), reject(new DOMException('aborted', 'AbortError')));
        });
        if (!held) grant(r);
        else queue.push(r);
      }),
  } as unknown as SharedStreamDeps['locks'];
}

/** 假的 BroadcastChannel：发给同一个 hub 上别的频道，不发给自己 */
function hub() {
  const members = new Set<SharedStreamDeps['channel']>();
  return () => {
    const ch: SharedStreamDeps['channel'] = {
      onmessage: null,
      postMessage: (m) => {
        for (const o of members) if (o !== ch) queueMicrotask(() => o.onmessage?.({ data: structuredClone(m) }));
      },
      close: () => void members.delete(ch),
    };
    members.add(ch);
    return ch;
  };
}

/** 一个标签页：前台 / 后台、回到前台 */
function tab(locks: SharedStreamDeps['locks'], channel: () => SharedStreamDeps['channel'], visible: boolean) {
  const on = { open: vi.fn(), message: vi.fn(), error: vi.fn() };
  let show: (() => void) | null = null;
  const close = openSharedEventStream(on, {
    locks,
    channel: channel(),
    visible: () => visible,
    onVisible: (fn) => ((show = fn), () => (show = null)),
    make: () => new FakeSource() as unknown as EventSource,
  });
  return { on, close, show: () => show?.() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('几个标签页共用一条 /api/events（openSharedEventStream）', () => {
  afterEach(() => {
    FakeSource.all = [];
  });

  it('只有一个标签页连着；它收到的事件别的标签页也收到；后开的后台标签页拿到连上了、最近的 hello', async () => {
    const locks = fakeLocks();
    const channel = hub();
    const a = tab(locks, channel, true);
    await flush();
    expect(live()).toHaveLength(1);
    live()[0]!.open();
    live()[0]!.send('{"type":"hello","boot":"b1","lastId":3}');
    const b = tab(locks, channel, false);
    await flush();
    await flush();
    expect(live()).toHaveLength(1);
    expect(b.on.open).toHaveBeenCalledTimes(1);
    expect(b.on.message).toHaveBeenCalledWith('{"type":"hello","boot":"b1","lastId":3}');
    live()[0]!.send('{"type":"changed","id":4}');
    await flush();
    expect(a.on.message).toHaveBeenLastCalledWith('{"type":"changed","id":4}');
    expect(b.on.message).toHaveBeenLastCalledWith('{"type":"changed","id":4}');
    a.close();
    b.close();
  });

  it('连着的那个关掉了，排队的接上；回到前台的标签页把连接抢过来，原来的关掉自己的、跟着收', async () => {
    const locks = fakeLocks();
    const channel = hub();
    const a = tab(locks, channel, true);
    const b = tab(locks, channel, false);
    const c = tab(locks, channel, false);
    await flush();
    expect(live()).toHaveLength(1);
    const first = live()[0]!;
    a.close();
    await flush();
    await flush();
    expect(first.readyState).toBe(2);
    expect(live()).toHaveLength(1);
    // c 回到前台：抢过来；b 不再连着
    c.show();
    await flush();
    await flush();
    expect(live()).toHaveLength(1);
    live()[0]!.open();
    live()[0]!.send('{"type":"changed","id":9}');
    await flush();
    expect(b.on.message).toHaveBeenLastCalledWith('{"type":"changed","id":9}');
    expect(c.on.message).toHaveBeenLastCalledWith('{"type":"changed","id":9}');
    b.close();
    c.close();
    await flush();
    expect(live()).toHaveLength(0);
  });

  it('断了：跟着收的标签页也知道断了，再连上时跑 on.open', async () => {
    const locks = fakeLocks();
    const channel = hub();
    const a = tab(locks, channel, true);
    await flush();
    live()[0]!.open();
    const b = tab(locks, channel, false);
    await flush();
    await flush();
    expect(b.on.open).toHaveBeenCalledTimes(1);
    const s = live()[0]!;
    s.readyState = 0;
    s.onerror?.();
    await flush();
    expect(b.on.error).toHaveBeenCalledTimes(1);
    s.open();
    await flush();
    expect(b.on.open).toHaveBeenCalledTimes(2);
    a.close();
    b.close();
  });

  it('没有 Web Locks / BroadcastChannel：各连各的', () => {
    const on = { open: vi.fn(), message: vi.fn() };
    const original = globalThis.EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
    const close = openSharedEventStream(on, null);
    expect(live()).toHaveLength(1);
    close();
    (globalThis as { EventSource?: unknown }).EventSource = original;
  });
});
