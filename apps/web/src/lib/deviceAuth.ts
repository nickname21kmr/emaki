/**
 * 局域网入口上没有（或没了）设备凭证（docs/mobile.md 2.4、2.6）：手机浏览器打开 https://<电脑地址>:5175/ 时，
 * 所有 /api/ 都是 401 —— `unauthorized`（没批准过）或 `device_revoked`（被电脑移除了）。
 * 任何请求收到这两种 401（lib/api.ts 的 request()；SSE 断开时 lib/connection.ts 探一次 /api/health），整页换成「连接到电脑」
 * （main.tsx → features/access/PairingPage）。本机入口没有这两种 401，不会出现这个页面。
 *
 * 403 forbidden 另外通知订阅者（onForbidden）：权限可能刚在电脑上被改了，lib/capabilities.ts 据此重新取 GET /api/me。
 * 在安卓 App 里（App 给 WebView 注入了 `window.EmakiApp`，docs/mobile.md 第 3 节）不显示这个页面（它是给浏览器用的）：
 * 交给 App 的 `unpaired(code)`，App 回到自己的「已被电脑移除」页面。
 */
import { create } from 'zustand';

export type DeviceAuthLost = 'unauthorized' | 'device_revoked';

export const useDeviceAuth = create<{ lost: DeviceAuthLost | null }>(() => ({ lost: null }));

/** 是不是「这台设备没有凭证 / 被移除了」 */
export const isDeviceAuthFailure = (status: number, code: string | undefined): code is DeviceAuthLost =>
  status === 401 && (code === 'unauthorized' || code === 'device_revoked');

const forbiddenListeners = new Set<(path: string) => void>();

/** 订阅 403 forbidden（参数是请求的路径，不含 /api 前缀）。返回取消订阅 */
export function onForbidden(fn: (path: string) => void): () => void {
  forbiddenListeners.add(fn);
  return () => void forbiddenListeners.delete(fn);
}

/** 安卓 App 注入的接口（apps/android 的 WebScreen.kt） */
interface EmakiAppBridge {
  unpaired(code: DeviceAuthLost): void;
  /** 连不上电脑了（lib/connection.ts）：App 核实后切到原生的「电脑不在线」。老版本的 App 没有 */
  connectionLost?(): void;
  /** 「从手机添加」：App 打开系统的选图界面，选完在后台传给电脑（docs/mobile.md 5.4）。0.2.0 起才有 */
  pickImages?(): void;
}

export const appBridge = (): EmakiAppBridge | undefined => (globalThis as { EmakiApp?: EmakiAppBridge }).EmakiApp;

/**
 * 收到一个失败的响应时调用：是那两种 401 就切到配对页（被移除的说法优先，不会被后来的 unauthorized 盖掉），在 App 里交给 App；
 * 403 forbidden 通知订阅者
 */
export function noteResponse(status: number, code: string | undefined, path = ''): void {
  if (status === 403 && code === 'forbidden') for (const fn of forbiddenListeners) fn(path);
  if (!isDeviceAuthFailure(status, code)) return;
  const app = appBridge();
  if (app) {
    app.unpaired(code);
    return;
  }
  const cur = useDeviceAuth.getState().lost;
  if (cur === code || cur === 'device_revoked') return;
  useDeviceAuth.setState({ lost: code });
}
