/**
 * 所有出网请求都走这里（模型下载、Danbooru、词库构建脚本）。
 * Node 内置 fetch 默认不读代理，这里用 undici 显式挂 ProxyAgent，代理地址见 proxy.ts。
 */
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { resolveProxy, type ProxyInfo } from './proxy.ts';

const dispatchers = new Map<string, Dispatcher>();

function dispatcherFor(proxy: string | null): Dispatcher {
  const key = proxy ?? '';
  let d = dispatchers.get(key);
  if (!d) {
    d = proxy ? new ProxyAgent(proxy) : new Agent({ connect: { timeout: 15_000 } });
    dispatchers.set(key, d);
  }
  return d;
}

/** 连接层面的失败（不是 HTTP 状态码），带上当时用的代理，方便说清楚原因（见 diagnose.ts） */
export class NetworkError extends Error {
  constructor(
    readonly url: string,
    readonly proxy: ProxyInfo,
    cause: unknown,
  ) {
    super(`请求 ${new URL(url).host} 失败：${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = 'NetworkError';
  }
}

export async function httpFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  const proxy = await resolveProxy();
  try {
    return await undiciFetch(url, { ...init, dispatcher: dispatcherFor(proxy.url) });
  } catch (err) {
    // 用户取消要原样抛出；超时（AbortSignal.timeout）算网络问题
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new NetworkError(url, proxy, err);
  }
}

/** 测试里可注入的最小 fetch 形状（避免 undici Response 与全局 Response 类型不兼容） */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>;
export const defaultFetchLike: FetchLike = (url, init) => httpFetch(url, init);
