/**
 * 局域网入口上没有（或没了）设备凭证（docs/mobile.md 2.4、2.6）：手机浏览器打开 https://<电脑地址>:5175/ 时，
 * 所有 /api/ 都是 401 —— `unauthorized`（没批准过）或 `device_revoked`（被电脑移除了）。
 * 任何请求收到这两种 401（lib/api.ts 的 request()；SSE 连不上时 lib/events.ts 再探一次），整页换成「连接到电脑」
 * （main.tsx → features/access/PairingPage）。本机入口没有这两种 401，不会出现这个页面。
 */
import { create } from 'zustand';

export type DeviceAuthLost = 'unauthorized' | 'device_revoked';

export const useDeviceAuth = create<{ lost: DeviceAuthLost | null }>(() => ({ lost: null }));

/** 是不是「这台设备没有凭证 / 被移除了」 */
export const isDeviceAuthFailure = (status: number, code: string | undefined): code is DeviceAuthLost =>
  status === 401 && (code === 'unauthorized' || code === 'device_revoked');

/** 收到一个失败的响应时调用：是那两种 401 就切到配对页（被移除的说法优先，不会被后来的 unauthorized 盖掉） */
export function noteResponse(status: number, code: string | undefined): void {
  if (!isDeviceAuthFailure(status, code)) return;
  const cur = useDeviceAuth.getState().lost;
  if (cur === code || cur === 'device_revoked') return;
  useDeviceAuth.setState({ lost: code });
}
