/**
 * 连不上电脑（lib/connection.ts、features/access/ConnectionBanner.tsx，docs/mobile.md 4.3）：
 * - 怀疑断了（SSE 出错、请求网络错误或 10 秒没回应）探一次 /api/health：探不通（连不上、3 秒超时、502）→ offline；
 *   401 / 403 不算（401 照样交给 lib/deviceAuth.ts）；探通 → online；
 * - offline 时后台 5、10、20、30、30… 秒探一次；
 * - 重新连上（探通、SSE 重新连上）：全部重新取，图片纪元加一，只有加载失败过的图片换地址；
 * - 在安卓 App 里：调 window.EmakiApp.connectionLost()，不显示提示条；老 App 没有这个方法时照常显示。
 */
import type { QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionBannerView, ConnectionNotice, OFFLINE_TEXT, showConnectionBanner } from '@/features/access/ConnectionBanner';
import { request } from './api';
import {
  appHandlesOffline,
  imageFailed,
  PROBE_TIMEOUT_MS,
  resetConnection,
  retryNow,
  retryParam,
  streamBroken,
  streamOpened,
  suspect,
  useConnection,
  watchConnection,
  withRetry,
  type ImageFailure,
} from './connection';
import { useDeviceAuth } from './deviceAuth';

/** 电脑：up 时 /api/health 回 status，否则 fetch 抛 TypeError（和浏览器连不上时一样） */
const computer = { up: true, status: 200 };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  void init;
  if (!computer.up) throw new TypeError('Failed to fetch');
  const body = computer.status === 200 ? { ok: true } : { ok: false, code: computer.status === 401 ? 'unauthorized' : 'forbidden' };
  void url;
  return new Response(JSON.stringify(body), { status: computer.status, headers: { 'content-type': 'application/json' } });
});
const healthCalls = () => fetchMock.mock.calls.filter(([u]) => u === '/api/health').length;

/** 让 promise 链跑完（探的结果回来、状态改完） */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  resetConnection();
  useDeviceAuth.setState({ lost: null });
  computer.up = true;
  computer.status = 200;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  resetConnection();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('判断：探 /api/health', () => {
  it('SSE 断开 + 探不通 → offline', async () => {
    computer.up = false;
    streamBroken();
    await settle();
    expect(healthCalls()).toBe(1);
    expect(useConnection.getState().status).toBe('offline');
  });

  it('SSE 断开但探得通（短暂掉线）→ 还是 online', async () => {
    streamBroken();
    await settle();
    expect(healthCalls()).toBe(1);
    expect(useConnection.getState().status).toBe('online');
  });

  it('3 秒没回应算探不通', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    suspect();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(useConnection.getState().status).toBe('online');
    await vi.advanceTimersByTimeAsync(1);
    expect(useConnection.getState().status).toBe('offline');
  });

  it('401 / 403 不算断线；401 照样交给 deviceAuth（局域网入口上凭证没了）', async () => {
    computer.status = 403;
    suspect();
    await settle();
    expect(useConnection.getState().status).toBe('online');
    computer.status = 401;
    suspect();
    await settle();
    expect(useConnection.getState().status).toBe('online');
    expect(useDeviceAuth.getState().lost).toBe('unauthorized');
  });

  it('502（开发时 vite 代理连不上后端）算探不通', async () => {
    computer.status = 502;
    suspect();
    await settle();
    expect(useConnection.getState().status).toBe('offline');
  });

  it('同时来的几次怀疑只探一次', async () => {
    suspect();
    suspect();
    streamBroken();
    await settle();
    expect(healthCalls()).toBe(1);
  });

  it('request() 遇到网络错误时探一次；10 秒没回应也探一次（请求本身不打断）', async () => {
    computer.up = false;
    await expect(request('GET', '/summary')).rejects.toMatchObject({ code: 'network' });
    await settle();
    expect(healthCalls()).toBe(1);
    expect(useConnection.getState().status).toBe('offline');

    resetConnection();
    computer.up = true;
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (finish = r)));
    const slow = request('GET', '/duplicates');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(healthCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(healthCalls()).toBe(2);
    expect(useConnection.getState().status).toBe('online');
    finish(new Response('{"groups":[]}', { status: 200 }));
    await expect(slow).resolves.toEqual({ groups: [] });
  });
});

describe('offline 以后：后台退避着探，连上了全部重新取', () => {
  it('5、10、20、30、30 秒探一次', async () => {
    computer.up = false;
    suspect();
    await settle();
    expect(healthCalls()).toBe(1);
    const at: number[] = [];
    let last = healthCalls();
    for (let t = 1; t <= 95; t++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (healthCalls() > last) {
        at.push(t);
        last = healthCalls();
      }
    }
    expect(at).toEqual([5, 15, 35, 65, 95]);
  });

  it('探通了 → online：提示收起、所有查询重新取、图片纪元加一；退避从头算', async () => {
    const invalidateQueries = vi.fn(async () => {});
    const stop = watchConnection({ invalidateQueries } as unknown as QueryClient);
    computer.up = false;
    suspect();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(healthCalls()).toBe(2);
    computer.up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useConnection.getState()).toMatchObject({ status: 'online', epoch: 1 });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith();
    // 连上以后不再定时探
    const n = healthCalls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthCalls()).toBe(n);
    // 再断一次：又从 5 秒开始
    computer.up = false;
    suspect();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(healthCalls()).toBe(n + 2);
    stop();
  });

  it('「重试」马上探', async () => {
    computer.up = false;
    suspect();
    await settle();
    computer.up = true;
    await retryNow();
    expect(healthCalls()).toBe(2);
    expect(useConnection.getState().status).toBe('online');
  });

  it('SSE 重新连上也算连上；只是短暂断过（一直是 online）的话只让失败过的图片重试，不全部重新取', async () => {
    const invalidateQueries = vi.fn(async () => {});
    const stop = watchConnection({ invalidateQueries } as unknown as QueryClient);
    computer.up = false;
    streamBroken();
    await settle();
    expect(useConnection.getState().status).toBe('offline');
    streamOpened();
    expect(useConnection.getState()).toMatchObject({ status: 'online', epoch: 1 });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    computer.up = true;
    streamBroken();
    await settle();
    streamOpened();
    expect(useConnection.getState()).toMatchObject({ status: 'online', epoch: 2 });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    // 第一次连上（没断过）什么也不变
    streamOpened();
    expect(useConnection.getState().epoch).toBe(2);
    stop();
  });
});

describe('图片：重新连上后，只有加载失败过的换地址重新加载', () => {
  const src = '/api/images/a/thumb?w=480&v=1';

  it('没失败过：纪元怎么变地址都不变（缓存照用）', () => {
    expect(retryParam(null, src, 0)).toBe(0);
    expect(retryParam(null, src, 5)).toBe(0);
    expect(withRetry(src, 0)).toBe(src);
  });

  it('失败了：纪元变了才换地址，之后再连上也不再换；重试的地址又失败了，下次连上再换', () => {
    let f: ImageFailure = { src, failedAt: 0, retry: 0 };
    expect(retryParam(f, src, 0)).toBe(0);
    expect(retryParam(f, src, 1)).toBe(1);
    expect(withRetry(src, 1)).toBe(`${src}&r=1`);
    expect(withRetry('/api/images/a/file', 1)).toBe('/api/images/a/file?r=1');
    // r=1 加载成功：之后的纪元不再换
    expect(retryParam(f, src, 3)).toBe(1);
    // r=1 在纪元 1 又失败了：纪元还是 1 时保持 r=1（不来回换），到纪元 2 换成 r=2
    f = { src, failedAt: 1, retry: 1 };
    expect(retryParam(f, src, 1)).toBe(1);
    expect(retryParam(f, src, 2)).toBe(2);
  });

  it('图片加载失败也探一下；刚探通过的 5 秒内不因为图片再探（文件不在了这类）', async () => {
    imageFailed();
    await settle();
    expect(healthCalls()).toBe(1);
    imageFailed();
    await settle();
    expect(healthCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    computer.up = false;
    imageFailed();
    await settle();
    expect(healthCalls()).toBe(2);
    expect(useConnection.getState().status).toBe('offline');
  });

  it('换了一张图（src 变了）：从头算', () => {
    expect(retryParam({ src, failedAt: 0, retry: 0 }, '/api/images/b/thumb?w=480', 3)).toBe(0);
  });
});

describe('提示条：浏览器里显示，App 里交给 App', () => {
  /** ConnectionBanner 的判断：用现在的连接状态、有没有 App 接管；local 是本机入口 */
  const shown = (local = false) => showConnectionBanner({ status: useConnection.getState().status, inApp: appHandlesOffline(), local });
  const view = (on: boolean) => renderToStaticMarkup(<ConnectionBannerView shown={on} probing={false} onRetry={() => {}} />);

  it('什么时候显示', () => {
    expect(showConnectionBanner({ status: 'offline', inApp: false, local: false })).toBe(true);
    expect(showConnectionBanner({ status: 'online', inApp: false, local: false })).toBe(false);
    expect(showConnectionBanner({ status: 'offline', inApp: true, local: false })).toBe(false);
    // 本机入口（电脑自己的浏览器）不显示
    expect(showConnectionBanner({ status: 'offline', inApp: false, local: true })).toBe(false);
  });

  it('手机浏览器：探不通以后顶部显示提示和「重试」', async () => {
    computer.up = false;
    streamBroken();
    await settle();
    expect(shown()).toBe(true);
    expect(shown(true)).toBe(false);
    const html = view(true);
    expect(html).toContain(OFFLINE_TEXT);
    expect(html).toContain('重试');
    expect(view(false)).not.toContain(OFFLINE_TEXT);
    expect(renderToStaticMarkup(<ConnectionNotice probing onRetry={() => {}} />)).toContain('disabled');
  });

  it('在 App 里：探不通时调 connectionLost()（每次探不通都调，App 自己去重），不显示提示条', async () => {
    const connectionLost = vi.fn();
    vi.stubGlobal('EmakiApp', { unpaired: vi.fn(), connectionLost });
    computer.up = false;
    streamBroken();
    await settle();
    expect(useConnection.getState().status).toBe('offline');
    expect(connectionLost).toHaveBeenCalledTimes(1);
    expect(shown()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connectionLost).toHaveBeenCalledTimes(2);
    // 探通了不再调
    computer.up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useConnection.getState().status).toBe('online');
    expect(connectionLost).toHaveBeenCalledTimes(2);
  });

  it('老版本的 App（只有 unpaired）：和浏览器一样显示提示条', async () => {
    vi.stubGlobal('EmakiApp', { unpaired: vi.fn() });
    computer.up = false;
    suspect();
    await settle();
    expect(shown()).toBe(true);
  });
});
