/**
 * 和电脑的连接（docs/mobile.md 4.3）：online / offline。
 *
 * 怀疑断了的时候探一次 `GET /api/health`（3 秒超时）：SSE 出错（lib/events.ts）、请求遇到网络错误或者 10 秒还没回应（lib/api.ts）、
 * 图片加载失败（useImageRetry）、浏览器说断网了。
 * - 有回应就是连着的。401 / 403 也算：那是凭证、权限的事，交给 lib/deviceAuth.ts（这里照样报给它，SSE 断开时靠这个发现凭证没了）；
 * - 502 / 503 / 504（开发时 vite 代理连不上后端）、超时、连不上：offline。
 *
 * offline 时：
 * - 在安卓 App 里（App 注入的 `window.EmakiApp` 有 connectionLost）：每次探不通都告诉 App，App 自己核实后切到原生的「电脑不在线」页面，
 *   网页不显示别的；
 * - 在浏览器里：顶部一条不会自己消失的提示（features/access/ConnectionBanner.tsx），带「重试」。
 * 后台每 5 秒探一次，逐步放慢到 30 秒；「重试」马上探。
 *
 * 重新连上（探通了，或者 SSE 重新连上）：提示收起；所有查询重新取（watchConnection 接上的 QueryClient）；
 * 图片纪元加一，加载失败过的图片换个地址重新加载（useImageRetry），没失败的地址不变，缓存照用。
 */
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { create } from 'zustand';
import { appBridge, noteResponse } from './deviceAuth';

export type ConnectionStatus = 'online' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** 图片纪元：每次重新连上（或者 SSE 断过又连上）加一 */
  epoch: number;
  /** 正在探 */
  probing: boolean;
}

export const useConnection = create<ConnectionState>(() => ({ status: 'online', epoch: 0, probing: false }));

export const PROBE_TIMEOUT_MS = 3_000;
/** offline 时多久探一次：5 秒起，逐步放慢到 30 秒 */
export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;
/** 请求这么久还没回应：探一下（不打断请求本身，导入、查重这类本来就慢的请求照常等） */
export const SLOW_REQUEST_MS = 10_000;

let inflight: Promise<boolean> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** offline 以后第几次探 */
let attempt = 0;
/** SSE 出过错，还没重新连上 */
let streamBroke = false;
/** 上次探通的时间 */
let lastOk = 0;
/** 刚探通过的话，图片加载失败多半是图片自己的问题（文件不在了），这么久之内不因为图片再探 */
const IMAGE_QUIET_MS = 5_000;
const reconnectListeners = new Set<() => void>();

/** 安卓 App 接管断线（有 window.EmakiApp.connectionLost）；老版本的 App 没有，那就和浏览器一样显示提示条 */
export const appHandlesOffline = (): boolean => typeof appBridge()?.connectionLost === 'function';

/** 探一次：电脑有回应就是 true */
export async function probe(): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
    if (res.status === 502 || res.status === 503 || res.status === 504) return false;
    if (!res.ok) {
      const code = await res
        .json()
        .then((b: { code?: string } | null) => b?.code)
        .catch(() => undefined);
      noteResponse(res.status, code, '/health');
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** 探一次，按结果改状态；已经在探的话等那一次 */
function check(): Promise<boolean> {
  if (inflight) return inflight;
  useConnection.setState({ probing: true });
  const p = probe().then((ok) => {
    inflight = null;
    useConnection.setState({ probing: false });
    if (ok) lastOk = Date.now();
    if (ok) markOnline();
    else markOffline();
    return ok;
  });
  inflight = p;
  return p;
}

function markOffline() {
  if (useConnection.getState().status !== 'offline') {
    useConnection.setState({ status: 'offline' });
    attempt = 0;
  }
  appBridge()?.connectionLost?.();
  clearTimeout(timer);
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  attempt++;
  timer = setTimeout(() => void check(), delay);
}

function markOnline() {
  clearTimeout(timer);
  attempt = 0;
  const s = useConnection.getState();
  if (s.status === 'online') return;
  // 纪元已经加过了：SSE 待会儿重新连上时不再加
  streamBroke = false;
  useConnection.setState({ status: 'online', epoch: s.epoch + 1 });
  for (const fn of reconnectListeners) fn();
}

/** 怀疑断了：探一下。已经是 offline 的话后台在定时探，不重复 */
export function suspect(): void {
  if (useConnection.getState().status === 'offline') return;
  void check();
}

/** 图片加载失败：刚探通过就不探了（一屏里好几张图找不到文件时不会一直探） */
export function imageFailed(): void {
  if (Date.now() - lastOk < IMAGE_QUIET_MS) return;
  suspect();
}

/** 「重试」：马上探（退避接着算） */
export function retryNow(): Promise<boolean> {
  clearTimeout(timer);
  return check();
}

/** SSE 出错（断开、连不上） */
export function streamBroken(): void {
  streamBroke = true;
  suspect();
}

/** SSE 连上了：offline 时算重新连上；只是短暂断过的话，图片纪元加一（那一会儿加载失败的图片再试一次） */
export function streamOpened(): void {
  const s = useConnection.getState();
  if (s.status === 'offline') return markOnline();
  if (streamBroke) useConnection.setState({ epoch: s.epoch + 1 });
  streamBroke = false;
}

/** 重新连上时调 fn。返回取消订阅 */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => void reconnectListeners.delete(fn);
}

/**
 * 在 main.tsx 调一次：重新连上时让所有查询重新取；浏览器说断网了马上探，
 * 网络回来了、页面回到前台（手机上后台的定时器会被停掉）时，offline 的话马上探
 */
export function watchConnection(client: QueryClient): () => void {
  const off = onReconnect(() => void client.invalidateQueries());
  if (typeof window === 'undefined') return off;
  const now = () => {
    if (useConnection.getState().status === 'offline') void retryNow();
  };
  const visible = () => {
    if (document.visibilityState === 'visible') now();
  };
  window.addEventListener('offline', suspect);
  window.addEventListener('online', now);
  document.addEventListener('visibilitychange', visible);
  return () => {
    off();
    window.removeEventListener('offline', suspect);
    window.removeEventListener('online', now);
    document.removeEventListener('visibilitychange', visible);
  };
}

/** 测试用：回到初始状态 */
export function resetConnection(): void {
  clearTimeout(timer);
  inflight = null;
  attempt = 0;
  streamBroke = false;
  lastOk = 0;
  reconnectListeners.clear();
  useConnection.setState({ status: 'online', epoch: 0, probing: false });
}

// ------------------------------------------------------------------ 图片：重新连上后，加载失败过的重新加载

/** 一张图的加载记录：src 在纪元 failedAt 时加载失败（null 是没失败过），当时用的 r 参数是 retry */
export interface ImageFailure {
  src: string;
  failedAt: number | null;
  retry: number;
}

/** 这次用哪个 r 参数：失败之后纪元变了，换成「失败时的纪元 + 1」；否则不变（没失败过是 0：不加参数，地址和缓存都不动） */
export function retryParam(f: ImageFailure | null, src: string, epoch: number): number {
  if (!f || f.src !== src) return 0;
  return f.failedAt !== null && epoch > f.failedAt ? f.failedAt + 1 : f.retry;
}

export const withRetry = (src: string, retry: number): string =>
  retry ? `${src}${src.includes('?') ? '&' : '?'}r=${retry}` : src;

/**
 * `<img src={x.src} onError={x.onError}>`：加载失败时记下当时的图片纪元，并让连接状态探一下（是不是电脑不在了，imageFailed）；
 * 重新连上（纪元变了）后在地址后面加 `r=<n>`，浏览器当成新地址重新请求。只有失败过的图片会换地址
 */
export function useImageRetry(src: string): { src: string; onError: () => void } {
  const epoch = useConnection((s) => s.epoch);
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const retry = retryParam(failure, src, epoch);
  const onError = useCallback(() => {
    setFailure({ src, failedAt: useConnection.getState().epoch, retry });
    imageFailed();
  }, [src, retry]);
  return { src: withRetry(src, retry), onError };
}
