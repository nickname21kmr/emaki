/**
 * 浏览器配对（docs/mobile.md 2.3）：手机浏览器打开局域网入口（https://<电脑地址>:5175/）、还没有凭证时，
 * 网页照服务端 apps/server/src/access/pairing.ts 文件头的协议走一遍：
 *   hello → 生成 nonceA，POST /api/v1/pair（commit = sha256(nonceA)）→ 拿到电脑的 nonceB 后才 POST …/reveal 公开 nonceA
 *   → 自己算出校验码给人看 → 长轮询 GET /api/v1/pair/:id?wait=25&cookie=1，批准时服务端顺带 Set-Cookie，重新加载页面就进图库了。
 *
 * 安全性（和 App 那条路不一样）：网页拿不到 TLS 证书，校验码里的证书指纹只能用 hello 返回的 fingerprint。
 * 中间人可以同时换掉证书和 hello 里的指纹，两边算出来的数照样一样，所以**浏览器这条路防不了中间人**；
 * 它防的是同一 Wi-Fi 下有人冒充你的手机发请求（冒充者手机上的数字你看不到，nonceA 又被 commit 绑死了，凑不出电脑上显示的数）。
 * 防中间人靠 App：App 用自己在 TLS 握手里看到的证书算校验码。
 *
 * 这里的请求不走 lib/api.ts 的 request()：配对的接口不要凭证、不会 401，长轮询还要能中途取消。
 */
import type { LanHello, PairStarted, PairStatus } from '@emaki/shared';
import { fromHex, sha256, toHex } from '@/lib/sha256';

const PAIR_LABEL = new TextEncoder().encode('emaki-pair-v1');

/** 校验码：sha256("emaki-pair-v1" ‖ fp ‖ nonceA ‖ nonceB) 的前 4 字节按大端读成无符号整数，模 1 000 000，补零到 6 位（同服务端 pairingCode） */
export async function pairingCode(fingerprint: Uint8Array, nonceA: Uint8Array, nonceB: Uint8Array): Promise<string> {
  const buf = new Uint8Array(PAIR_LABEL.length + fingerprint.length + nonceA.length + nonceB.length);
  let off = 0;
  for (const part of [PAIR_LABEL, fingerprint, nonceA, nonceB]) {
    buf.set(part, off);
    off += part.length;
  }
  const h = await sha256(buf);
  const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0);
  return String(n % 1_000_000).padStart(6, '0');
}

/** 「123 456」：按 3 + 3 分组，方便对着念 */
export const groupCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

// ------------------------------------------------------------------ 从 UA 猜设备名称

const BROWSERS: [RegExp, string][] = [
  [/MicroMessenger/i, '微信'],
  [/\bQQ\//i, 'QQ'],
  [/EdgA?\//, 'Edge'],
  [/SamsungBrowser/, '三星浏览器'],
  [/HuaweiBrowser/, '华为浏览器'],
  [/MiuiBrowser/, '小米浏览器'],
  [/QQBrowser/, 'QQ 浏览器'],
  [/UCBrowser/, 'UC 浏览器'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/CriOS|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/**
 * 从 UA 猜「设备名称」（可改）和「型号」（电脑上设备列表里显示）。
 * 名称：iPhone、iPad、Android 手机 / 平板（UA 里有真实型号时用型号，如 Pixel 7；新版 Chrome 把型号统一成「K」，这时不用）；
 * 型号：浏览器 · 系统版本，如「Chrome · Android 14」「Safari · iOS 17.4」。
 */
export function guessDevice(ua: string): { name: string; model: string } {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  let name = '手机浏览器';
  let os: string | null = null;
  const ios = /\b(iPhone|iPad|iPod)\b.*?OS (\d+(?:_\d+)?)/.exec(ua);
  const android = /Android\s*([\d.]+)?(?:;\s*([^;)]+))?/.exec(ua);
  if (ios) {
    name = ios[1] === 'iPod' ? 'iPod' : ios[1]!;
    os = `iOS ${ios[2]!.replace('_', '.')}`;
  } else if (android) {
    const model = android[2]?.replace(/\s*Build\/.*$/, '').trim();
    const generic = !model || model === 'K' || /^(Linux|U|wv|Mobile|[a-z]{2}[-_][a-z]{2})$/i.test(model);
    name = generic ? (/Mobile/.test(ua) ? 'Android 手机' : 'Android 平板') : model;
    os = android[1] ? `Android ${android[1]}` : 'Android';
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    // iPadOS 13 起默认用桌面版 UA（Macintosh），这里分不出来
    name = 'Mac';
    os = 'macOS';
  } else if (/Windows/.test(ua)) {
    name = 'Windows 电脑';
    os = 'Windows';
  } else if (/Linux|X11/.test(ua)) {
    name = 'Linux 电脑';
    os = 'Linux';
  }
  return { name: name.slice(0, 60), model: [browser, os].filter(Boolean).join(' · ').slice(0, 100) };
}

// ------------------------------------------------------------------ 协议

export class PairError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** 配对用的请求（同源，不带凭证）。fetch 可以换成假的（测试） */
export async function lanCall<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(path, {
      method,
      signal: opts.signal,
      // 局域网入口的 POST 必须是 JSON（同源检查在服务端）
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new PairError('连不上电脑：看看电脑上的 Emaki 还开着、手机和电脑在同一个 Wi-Fi 里');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error;
    throw new PairError(message || `请求失败（${res.status}）`, res.status);
  }
  return data as T;
}

export const getHello = (opts: { signal?: AbortSignal; fetch?: typeof fetch } = {}) => lanCall<LanHello>('GET', '/api/v1/hello', opts);

export interface PairAttempt {
  /** 协议里的请求编号（兼凭据，只有这台手机知道） */
  id: string;
  /** 6 位校验码 */
  code: string;
  expiresAt: string;
}

/**
 * 第 1–3 步：提交 commit → 拿到 nonceB → 公开 nonceA → 自己算校验码。
 * fingerprint 是 hello 里的证书指纹（hex）。random 可以换成固定的（测试）
 */
export async function startPairing(
  hello: Pick<LanHello, 'fingerprint'>,
  device: { name: string; model?: string },
  opts: { fetch?: typeof fetch; random?: (n: number) => Uint8Array; signal?: AbortSignal } = {},
): Promise<PairAttempt> {
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const nonceA = random(32);
  const commit = toHex(await sha256(nonceA));
  const call = { fetch: opts.fetch, signal: opts.signal };
  const started = await lanCall<PairStarted>('POST', '/api/v1/pair', {
    ...call,
    body: { name: device.name, ...(device.model ? { model: device.model } : {}), commit },
  });
  // 看到电脑的随机数之后才公开自己的
  await lanCall<{ ok: true }>('POST', `/api/v1/pair/${encodeURIComponent(started.id)}/reveal`, { ...call, body: { nonce: toHex(nonceA) } });
  const code = await pairingCode(fromHex(hello.fingerprint), nonceA, fromHex(started.nonce));
  return { id: started.id, code, expiresAt: started.expiresAt };
}

/**
 * 第 4 步：长轮询到有结果（批准、拒绝、过期）。带 cookie=1：批准时服务端顺带 Set-Cookie，之后的请求都带着凭证。
 * 中途连不上时隔几秒再问（手机锁屏、切到后台会断），signal 取消
 */
export async function waitForDecision(
  id: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; retryMs?: number } = {},
): Promise<Exclude<PairStatus, { status: 'pending' }>> {
  for (;;) {
    let s: PairStatus;
    try {
      s = await lanCall<PairStatus>('GET', `/api/v1/pair/${encodeURIComponent(id)}?wait=25&cookie=1`, opts);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || (err instanceof PairError && err.status)) throw err;
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 3000));
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      continue;
    }
    if (s.status !== 'pending') return s;
  }
}
