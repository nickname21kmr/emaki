/**
 * 所有出网请求都走这里（模型下载、Danbooru、词库构建脚本）。
 * Node 内置 fetch 默认不读代理环境变量，这里用 undici 显式挂 ProxyAgent。
 */
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../config.ts';

let dispatcher: Dispatcher | undefined;

function getDispatcher(): Dispatcher {
  dispatcher ??= config.httpProxy ? new ProxyAgent(config.httpProxy) : new Agent({ connect: { timeout: 15_000 } });
  return dispatcher;
}

export function httpFetch(url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return undiciFetch(url, { ...init, dispatcher: getDispatcher() });
}

/** 测试里可注入的最小 fetch 形状（避免 undici Response 与全局 Response 类型不兼容） */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponse>;
export const defaultFetchLike: FetchLike = (url, init) => httpFetch(url, init);
