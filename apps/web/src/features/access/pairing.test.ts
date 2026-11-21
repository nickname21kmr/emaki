/**
 * 浏览器配对（协议见服务端 apps/server/src/access/pairing.ts 文件头）：
 * 校验码和服务端 pairingCode() 用同一组测试向量（apps/server/test/access/pairing.test.ts），没有 crypto.subtle 时也一样；
 * 从 UA 猜设备名称；按协议走一遍（commit / reveal / 长轮询带 cookie=1）。
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupCode, guessDevice, PairError, pairingCode, startPairing, waitForDecision } from './pairing';

const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

describe('校验码：和服务端同一组测试向量', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sha256("emaki-pair-v1" ‖ fp ‖ nonceA ‖ nonceB) 前 4 字节大端 mod 1e6，补零到 6 位', async () => {
    const z = bytes(32);
    expect(await pairingCode(z, z, z)).toBe('559142');
    expect(await pairingCode(bytes(32, 1), bytes(32, 2), z)).toBe('645456');
    // 三段的顺序有意义
    expect(await pairingCode(z, bytes(32, 1), z)).not.toBe(await pairingCode(z, z, bytes(32, 1)));
  });

  it('非安全上下文（没有 crypto.subtle）算出来一样', async () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(await pairingCode(bytes(32), bytes(32), bytes(32))).toBe('559142');
    expect(await pairingCode(bytes(32, 1), bytes(32, 2), bytes(32))).toBe('645456');
  });

  it('按 3 + 3 分组', () => {
    expect(groupCode('012345')).toBe('012 345');
    expect(groupCode('12345')).toBe('12345');
  });
});

describe('从 UA 猜设备名称', () => {
  const cases: [string, string, { name: string; model: string }][] = [
    [
      'Pixel 7（Playwright 的设备）',
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      { name: 'Pixel 7', model: 'Chrome · Android 14' },
    ],
    [
      '新版 Chrome 把型号统一成 K',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      { name: 'Android 手机', model: 'Chrome · Android 10' },
    ],
    [
      'Android 平板（没有 Mobile）',
      'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      { name: 'Android 平板', model: 'Chrome · Android 13' },
    ],
    [
      'Android 上的 Firefox',
      'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
      { name: 'Android 手机', model: 'Firefox · Android 14' },
    ],
    [
      '三星浏览器带真实型号',
      'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      { name: 'SM-S911B', model: '三星浏览器 · Android 13' },
    ],
    [
      'iPhone 上的 Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
        'Version/17.4 Mobile/15E148 Safari/604.1',
      { name: 'iPhone', model: 'Safari · iOS 17.4' },
    ],
    [
      'iPhone 上的 Chrome',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
        'CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
      { name: 'iPhone', model: 'Chrome · iOS 17.4' },
    ],
    [
      '微信里打开',
      'Mozilla/5.0 (Linux; Android 12; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47',
      { name: 'Android 手机', model: '微信 · Android 12' },
    ],
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      { name: 'iPad', model: 'Safari · iOS 16.6' },
    ],
    [
      'Windows 上的 Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      { name: 'Windows 电脑', model: 'Edge · Windows' },
    ],
    ['认不出来', '', { name: '手机浏览器', model: '' }],
  ];
  it.each(cases)('%s', (_, ua, expected) => {
    expect(guessDevice(ua)).toEqual(expected);
  });
});

/** 假的局域网入口：记下请求，按顺序回答 */
function fakeLan(answers: ((url: string, init: RequestInit) => { status?: number; body: unknown } | Error)[]) {
  const calls: { url: string; method: string; body: unknown; headers: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', body, headers: init.headers });
    const next = answers.shift();
    if (!next) throw new Error(`没有准备回答：${url}`);
    const r = next(url, init);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe('按协议走一遍', () => {
  it('commit = sha256(nonceA)，看到 nonceB 后才公开 nonceA，校验码按 hello 里的证书指纹算', async () => {
    const lan = fakeLan([
      () => ({ body: { id: 'req-key', nonce: '00'.repeat(32), expiresAt: '2026-11-18T10:05:00.000Z' } }),
      () => ({ body: { ok: true } }),
    ]);
    const attempt = await startPairing(
      { fingerprint: '00'.repeat(32) },
      { name: 'Pixel 7', model: 'Chrome · Android 14' },
      { fetch: lan.fetch, random: (n) => bytes(n) },
    );
    expect(lan.calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/v1/pair'],
      ['POST', '/api/v1/pair/req-key/reveal'],
    ]);
    // 局域网入口的 POST 必须是 JSON
    for (const c of lan.calls) expect(c.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(lan.calls[0]!.body).toEqual({
      name: 'Pixel 7',
      model: 'Chrome · Android 14',
      commit: createHash('sha256').update(bytes(32)).digest('hex'),
    });
    expect(lan.calls[1]!.body).toEqual({ nonce: '00'.repeat(32) });
    // 指纹、nonceA、nonceB 全是 0：就是上面那个测试向量
    expect(attempt).toEqual({ id: 'req-key', code: '559142', expiresAt: '2026-11-18T10:05:00.000Z' });
  });

  it('服务端拒绝（限速等）：带着服务端的中文说明报错', async () => {
    const lan = fakeLan([() => ({ status: 429, body: { ok: false, code: 'too_many_requests', error: '请求太频繁了，请过几分钟再试' } })]);
    const err = await startPairing({ fingerprint: '00'.repeat(32) }, { name: 'x' }, { fetch: lan.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairError);
    expect(err).toMatchObject({ status: 429, message: '请求太频繁了，请过几分钟再试' });
  });

  it('长轮询带 wait=25&cookie=1（批准时服务端顺带 Set-Cookie），pending 接着问，连不上隔一会儿再问', async () => {
    const lan = fakeLan([
      () => ({ body: { status: 'pending' } }),
      () => new TypeError('Failed to fetch'),
      () => ({ body: { status: 'approved', deviceId: 'd1', token: 't' } }),
    ]);
    const result = await waitForDecision('a/b', { fetch: lan.fetch, retryMs: 1 });
    expect(result).toEqual({ status: 'approved', deviceId: 'd1', token: 't' });
    expect(lan.calls.map((c) => c.url)).toEqual(Array(3).fill('/api/v1/pair/a%2Fb?wait=25&cookie=1'));
  });

  it('拒绝、过期直接返回；服务端报错（比如 404）不再重试', async () => {
    for (const status of ['rejected', 'expired'])
      expect(await waitForDecision('x', { fetch: fakeLan([() => ({ body: { status } })]).fetch })).toEqual({ status });
    const gone = fakeLan([() => ({ status: 404, body: { ok: false, code: 'not_found', error: '这个请求不存在或已经过期' } })]);
    await expect(waitForDecision('x', { fetch: gone.fetch })).rejects.toMatchObject({ status: 404 });
  });

  it('取消：长轮询中途 abort 就停', async () => {
    const ctrl = new AbortController();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    );
    const p = waitForDecision('x', { fetch: fetch as unknown as typeof globalThis.fetch, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
