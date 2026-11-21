/**
 * 局域网入口上凭证没了 → 整页换成「连接到电脑」（lib/deviceAuth.ts）：
 * 任何请求收到 401 unauthorized / device_revoked 都算；别的错误（403 没权限、404、本机入口的各种失败）不算；
 * SSE 连不上时（EventSource 拿不到状态码）去探一下。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, request } from './api';
import { isDeviceAuthFailure, noteResponse, useDeviceAuth } from './deviceAuth';
import { openEventStream } from './events';

beforeEach(() => useDeviceAuth.setState({ lost: null }));
afterEach(() => vi.unstubAllGlobals());

describe('什么样的失败算「这台设备没有凭证」', () => {
  it('只有 401 unauthorized、401 device_revoked', () => {
    expect(isDeviceAuthFailure(401, 'unauthorized')).toBe(true);
    expect(isDeviceAuthFailure(401, 'device_revoked')).toBe(true);
    // 设备没有这个权限（比如局域网入口上的 GET /api/access）：不是凭证的问题，不切页面
    expect(isDeviceAuthFailure(403, 'forbidden')).toBe(false);
    expect(isDeviceAuthFailure(401, undefined)).toBe(false);
    expect(isDeviceAuthFailure(404, 'unauthorized')).toBe(false);
  });

  it('被移除的说法优先：之后再来 unauthorized 也不改', () => {
    noteResponse(403, 'forbidden');
    expect(useDeviceAuth.getState().lost).toBeNull();
    noteResponse(401, 'unauthorized');
    expect(useDeviceAuth.getState().lost).toBe('unauthorized');
    noteResponse(401, 'device_revoked');
    expect(useDeviceAuth.getState().lost).toBe('device_revoked');
    noteResponse(401, 'unauthorized');
    expect(useDeviceAuth.getState().lost).toBe('device_revoked');
  });
});

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );

describe('在安卓 App 里（有 window.EmakiApp）：交给 App，不显示网页的配对页', () => {
  it('两种 401 都调 unpaired(code)；别的错误不调', () => {
    const unpaired = vi.fn();
    vi.stubGlobal('EmakiApp', { unpaired });
    noteResponse(403, 'forbidden');
    noteResponse(401, 'device_revoked');
    noteResponse(401, 'unauthorized');
    expect(unpaired.mock.calls).toEqual([['device_revoked'], ['unauthorized']]);
    expect(useDeviceAuth.getState().lost).toBeNull();
  });

  it('request() 收到 401 device_revoked：照常抛错，交给 App', async () => {
    const unpaired = vi.fn();
    vi.stubGlobal('EmakiApp', { unpaired });
    respond(401, { ok: false, code: 'device_revoked', error: '这台设备已经被电脑移除，请重新请求连接' });
    await expect(request('GET', '/summary')).rejects.toMatchObject({ status: 401, code: 'device_revoked' });
    expect(unpaired).toHaveBeenCalledWith('device_revoked');
    expect(useDeviceAuth.getState().lost).toBeNull();
  });
});

describe('request()：任何请求收到这两种 401 都切到配对页', () => {
  it('401 device_revoked：照常抛错，同时记下', async () => {
    respond(401, { ok: false, code: 'device_revoked', error: '这台设备已经被电脑移除，请重新请求连接' });
    const err = await request('GET', '/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 401, code: 'device_revoked' });
    expect(useDeviceAuth.getState().lost).toBe('device_revoked');
  });

  it('写请求的 401 unauthorized 也算', async () => {
    respond(401, { ok: false, code: 'unauthorized', error: '需要先在电脑上批准这台设备' });
    await expect(request('POST', '/images/bulk', {})).rejects.toBeInstanceOf(ApiRequestError);
    expect(useDeviceAuth.getState().lost).toBe('unauthorized');
  });

  it('403（设备没有 devices 权限）、404、500 不切页面', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [404, 'not_found'],
      [500, 'internal'],
    ] as const) {
      respond(status, { ok: false, code, error: 'x' });
      await expect(request('GET', '/access')).rejects.toMatchObject({ status, code });
    }
    expect(useDeviceAuth.getState().lost).toBeNull();
  });
});

/** 假的 EventSource：手动触发 open / error */
class FakeSource {
  static made: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSource.made.push(this);
  }
  close() {
    this.readyState = 2;
  }
}

describe('SSE 连不上：探一下是不是凭证没了', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.made = [];
  });
  afterEach(() => vi.useRealTimers());

  it('连接被关掉（局域网入口 401 时 EventSource 直接关掉）才探；浏览器自己在重连（CONNECTING）时不探', () => {
    const closed = vi.fn();
    const stop = openEventStream({ open: () => {}, message: () => {}, closed }, () => new FakeSource() as unknown as EventSource);
    const first = FakeSource.made[0]!;
    first.readyState = 0;
    first.onerror!();
    expect(closed).not.toHaveBeenCalled();
    first.readyState = 2;
    first.onerror!();
    expect(closed).toHaveBeenCalledTimes(1);
    // 退避后重新建连接
    vi.advanceTimersByTime(1000);
    expect(FakeSource.made).toHaveLength(2);
    stop();
  });
});
