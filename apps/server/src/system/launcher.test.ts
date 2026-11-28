import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectLauncher, listenWhenFree, type LauncherProcess } from './launcher.ts';

/** 假的 process：记下后端发给启动器的消息，receive() 模拟启动器发来的 */
function fakeProcess(env: NodeJS.ProcessEnv, withIpc = true) {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  const proc: LauncherProcess = {
    env,
    ...(withIpc
      ? {
          send: (message, _handle, _options, callback) => {
            sent.push(message);
            callback?.(null);
            return true;
          },
        }
      : {}),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
  };
  return { proc, sent, receive: (message: unknown) => emitter.emit('message', message), listeners: () => emitter.listenerCount('message') };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connectLauncher：只认启动器起的后端', () => {
  it('没有 EMAKI_LAUNCHER（npm run dev 的 node --watch、vitest 的子进程也有 ipc 通道）→ null，一条消息都不发', () => {
    const f = fakeProcess({});
    expect(connectLauncher(f.proc)).toBeNull();
    expect(f.sent).toEqual([]);
    expect(f.listeners()).toBe(0);
  });

  it('有 EMAKI_LAUNCHER 但没有 ipc 通道 → null', () => {
    const f = fakeProcess({ EMAKI_LAUNCHER: '1' }, false);
    expect(connectLauncher(f.proc)).toBeNull();
    expect(f.listeners()).toBe(0);
  });

  it('接上之后先说一声 hello（从这时起收得到退出通知）', () => {
    const f = fakeProcess({ EMAKI_LAUNCHER: '1' });
    expect(connectLauncher(f.proc)).not.toBeNull();
    expect(f.sent).toEqual([{ type: 'emaki:hello' }]);
  });
});

describe('releasePort：监听之前请启动器让出端口', () => {
  it('发 before-listen，收到 port-free 才往下走；别的消息不算', async () => {
    const f = fakeProcess({ EMAKI_LAUNCHER: '1' });
    const launcher = connectLauncher(f.proc)!;
    let released = false;
    const waiting = launcher.releasePort().then(() => (released = true));
    expect(f.sent.at(-1)).toEqual({ type: 'emaki:before-listen' });
    f.receive({ 'watch:import': ['x'] });
    f.receive('port-free');
    f.receive(null);
    await Promise.resolve();
    expect(released).toBe(false);
    f.receive({ type: 'emaki:port-free' });
    await waiting;
    expect(released).toBe(true);
    // 等待用的监听摘掉了，只剩听 shutdown 的那一个
    expect(f.listeners()).toBe(1);
  });

  it('启动器一直不答复：等够 waitMs 照样往下走', async () => {
    vi.useFakeTimers();
    const f = fakeProcess({ EMAKI_LAUNCHER: '1' });
    const launcher = connectLauncher(f.proc)!;
    let released = false;
    void launcher.releasePort(3000).then(() => (released = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(f.listeners()).toBe(1);
  });
});

describe('onShutdown：启动器说窗口关了', () => {
  it('收到 shutdown 调最后一次设的处理函数；没设时不出错', () => {
    const f = fakeProcess({ EMAKI_LAUNCHER: '1' });
    const launcher = connectLauncher(f.proc)!;
    expect(() => f.receive({ type: 'emaki:shutdown' })).not.toThrow();
    const early = vi.fn();
    const late = vi.fn();
    launcher.onShutdown(early);
    launcher.onShutdown(late);
    f.receive({ type: 'emaki:port-free' });
    expect(late).not.toHaveBeenCalled();
    f.receive({ type: 'emaki:shutdown' });
    expect(early).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('listenWhenFree：端口刚让出来时可能还占不上', () => {
  const busy = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

  it('被占用就重试，占上了返回结果', async () => {
    let calls = 0;
    const result = await listenWhenFree(
      async () => {
        if (++calls < 3) throw busy();
        return 'ok';
      },
      { everyMs: 1, forMs: 1000 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('别的错误不重试，直接抛', async () => {
    let calls = 0;
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    await expect(
      listenWhenFree(
        async () => {
          calls++;
          throw denied;
        },
        { everyMs: 1, forMs: 1000 },
      ),
    ).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  it('一直被占用：到时间把占用的错误抛出来', async () => {
    let calls = 0;
    await expect(
      listenWhenFree(
        async () => {
          calls++;
          throw busy();
        },
        { everyMs: 5, forMs: 30 },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(calls).toBeGreaterThan(1);
  });
});
