/**
 * 设备与访问（docs/mobile.md 2.3、2.5、2.7）：设置 →「手机访问」用的查询和命令，执行函数只调用 access/。
 *
 * scope 全是 devices：只有本机入口能用，设备凭证永远拿不到（DEVICE_GRANTABLE_SCOPES 里没有它）；
 * AI 助手也没有这个范围，所以不会生成 MCP 工具。全部不可撤销、也不占撤销栈（undoable: false，barrier: false）。
 */
import type { AccessStatus, AccessTicket, DeviceInfo } from '@emaki/shared';
import { AccessConfigureInput, DeviceApproveInput, DeviceUpdateInput, EmptyInput, IdInput } from '@emaki/shared/schemas';
import { deviceInfo } from '../access/devices.ts';
import { defineCommand, defineQuery } from './registry.ts';

const quiet = { scope: 'devices', undoable: false, barrier: false, idempotent: false } as const;

export const accessQueries = [
  defineQuery({
    name: 'access.status',
    summary: '手机访问：局域网入口的开关、端口、电脑名称、证书指纹、地址、监听状态，等批准的请求，已批准的设备',
    input: EmptyInput,
    scope: 'devices',
    http: [{ method: 'GET', path: '/api/access' }],
    run: (e): AccessStatus => e.access.status(),
  }),
];

export const accessCommands = [
  defineCommand({
    name: 'access.configure',
    summary: '打开 / 关闭局域网入口、改端口、改电脑名称（name 为 null 恢复成计算机名），立即生效',
    input: AccessConfigureInput,
    ...quiet,
    http: [{ method: 'PATCH', path: '/api/access' }],
    async run(e, input): Promise<{ ok: true; message: string; status: AccessStatus }> {
      const status = await e.access.configure(input);
      const message = !status.enabled
        ? '已关闭手机访问'
        : status.error
          ? `手机访问没能打开：${status.error}`
          : `手机访问已打开（端口 ${status.port}）`;
      return { ok: true, message, status };
    },
  }),
  defineCommand({
    name: 'access.createTicket',
    summary: '生成扫码添加用的一次性口令（2 分钟有效，用一次就失效），返回二维码内容；局域网入口没开时 409',
    input: EmptyInput,
    ...quiet,
    http: [{ method: 'POST', path: '/api/access/tickets' }],
    run: (e): AccessTicket => e.access.createTicket(),
  }),
  defineCommand({
    name: 'devices.approve',
    summary: '批准一个连接请求（核对过两边的校验码）：scopes 不给就是默认权限，只能从可授予的范围里选',
    input: DeviceApproveInput,
    ...quiet,
    http: [{ method: 'POST', path: '/api/access/requests/:id/approve' }],
    run(e, input): { ok: true; message: string; device: DeviceInfo } {
      const device = e.access.approve(input.id, { scopes: input.scopes, name: input.name });
      return { ok: true, message: `已批准「${device.name}」`, device: deviceInfo(device) };
    },
  }),
  defineCommand({
    name: 'devices.reject',
    summary: '拒绝一个连接请求',
    input: IdInput,
    ...quiet,
    http: [{ method: 'POST', path: '/api/access/requests/:id/reject' }],
    run(e, input) {
      e.access.pairing.reject(input.id);
      return { ok: true as const, message: '已拒绝' };
    },
  }),
  defineCommand({
    name: 'devices.revoke',
    summary: '撤销一台设备：它的所有请求立即被拒绝，开着的事件连接立即断开',
    input: IdInput,
    ...quiet,
    http: [{ method: 'DELETE', path: '/api/devices/:id' }],
    run(e, input) {
      const device = e.access.revoke(input.id);
      return { ok: true as const, message: `已移除「${device.name}」` };
    },
  }),
  defineCommand({
    name: 'devices.update',
    summary: '改设备的名称、权限（下一个请求就按新的权限）',
    input: DeviceUpdateInput,
    ...quiet,
    http: [{ method: 'PATCH', path: '/api/devices/:id' }],
    run(e, input): { ok: true; message: string; device: DeviceInfo } {
      const device = e.access.update(input.id, { name: input.name, scopes: input.scopes });
      return { ok: true, message: `已更新「${device.name}」`, device: deviceInfo(device) };
    },
  }),
];
