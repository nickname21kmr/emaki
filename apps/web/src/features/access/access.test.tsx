/**
 * 设置 →「手机访问」和批准提示（docs/mobile.md 2.3–2.5）：
 * - access 事件 → 缓存：requested 先放进 GET /api/access 的缓存（提示马上弹出），任何 access 事件都重新取；SSE 连上（hello）也取，
 *   局域网入口上取到过 null（403）的不再取；
 * - 哪些请求弹提示：过期的、在这里批准 / 拒绝掉的不弹，设置页里的请求列表在屏幕上时都不弹；
 * - 剩余时间、权限的说法；
 * - 静态渲染：关着、开着没有设备、出错、有等待的请求（大号 3 + 3 校验码）、有设备，二维码。
 */
import {
  DEVICE_DEFAULT_SCOPES,
  DEVICE_GRANTABLE_SCOPES,
  SCOPES,
  type AccessStatus,
  type DeviceInfo,
  type PairRequestInfo,
  type Scope,
} from '@emaki/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { createInvalidator, handleServerEvent } from '@/lib/events';
import { qk } from '@/lib/queries';
import { visiblePrompts } from './AccessPrompts';
import { lastSeenText } from './DeviceList';
import { describeScopes, EXTRA_SCOPES, formatCountdown, scopeText } from './format';
import { AccessBody } from './PhoneAccessSection';
import { QrCode, TicketView } from './QrDialog';
import { ScopePicker } from './ScopePicker';

const NOW = Date.parse('2026-11-18T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const req = (id: string, over: Partial<PairRequestInfo> = {}): PairRequestInfo => ({
  id,
  code: '123456',
  name: 'Pixel 7',
  model: 'Chrome · Android 14',
  address: '192.168.1.23',
  createdAt: iso(NOW - 30_000),
  expiresAt: iso(NOW + 4 * 60_000 + 32_000),
  ...over,
});

const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: 'd1',
  name: '我的 Pixel',
  model: 'Chrome · Android 14',
  scopes: [...DEVICE_DEFAULT_SCOPES],
  createdAt: iso(NOW - 86_400_000),
  lastSeenAt: null,
  lastAddress: null,
  ...over,
});

const status = (over: Partial<AccessStatus> = {}): AccessStatus => ({
  enabled: true,
  port: 5175,
  name: null,
  defaultName: 'DESKTOP-EMAKI',
  serverId: 'srv',
  fingerprint: 'ab'.repeat(32),
  addresses: ['192.168.1.5'],
  listening: true,
  error: null,
  requests: [],
  devices: [],
  ...over,
});

describe('access 事件 → GET /api/access 的缓存', () => {
  const setup = (data: AccessStatus | null) => {
    const client = new QueryClient();
    client.setQueryData(qk.access, data);
    const { invalidate } = createInvalidator(client);
    return { client, send: (e: Parameters<typeof handleServerEvent>[2]) => handleServerEvent(client, invalidate, e) };
  };
  const invalid = (client: QueryClient) => client.getQueryState(qk.access)?.isInvalidated;

  it('requested：先把请求放进缓存（提示马上弹出），同时重新取；同一条不重复放', () => {
    const { client, send } = setup(status());
    send({ type: 'access', reason: 'requested', request: req('r1') });
    send({ type: 'access', reason: 'requested', request: req('r1') });
    expect(client.getQueryData<AccessStatus>(qk.access)!.requests.map((r) => r.id)).toEqual(['r1']);
    expect(invalid(client)).toBe(true);
  });

  it('changed（批准、拒绝、过期、撤销……）：重新取', () => {
    const { client, send } = setup(status({ requests: [req('r1')] }));
    send({ type: 'access', reason: 'changed' });
    expect(invalid(client)).toBe(true);
  });

  it('SSE 连上（hello）时重新取一次：access 事件不补发', () => {
    const { client, send } = setup(status());
    send({ type: 'hello', boot: 'b', lastId: 0 });
    expect(invalid(client)).toBe(true);
  });

  it('局域网入口（取到的是 null：设备没有 devices 权限）：hello 时不再取，免得每次连上都多一个 403', () => {
    const { client, send } = setup(null);
    send({ type: 'hello', boot: 'b', lastId: 0 });
    expect(invalid(client)).toBe(false);
  });
});

describe('哪些请求弹出批准提示', () => {
  const base = { now: NOW, handled: new Set<string>(), listOnScreen: false };
  const ids = (rs: PairRequestInfo[]) => rs.map((r) => r.id);

  it('每条请求一个提示；过期的收起', () => {
    const list = [req('a'), req('b'), req('old', { expiresAt: iso(NOW - 1) })];
    expect(ids(visiblePrompts(list, base))).toEqual(['a', 'b']);
  });

  it('在这里批准 / 拒绝成功的马上收起（不等重新取）；别处处理掉的随重新取的 requests 消失', () => {
    expect(ids(visiblePrompts([req('a'), req('b')], { ...base, handled: new Set(['a']) }))).toEqual(['b']);
    expect(ids(visiblePrompts([req('b')], base))).toEqual(['b']);
  });

  it('设置页里「等你批准的请求」在屏幕上时都不弹（那里列着，浮着的还会盖住开关），滚走了又弹出来', () => {
    expect(ids(visiblePrompts([req('a'), req('b')], { ...base, listOnScreen: true }))).toEqual([]);
    expect(ids(visiblePrompts([req('a'), req('b')], base))).toEqual(['a', 'b']);
  });
});

describe('显示规则', () => {
  it('剩余时间', () => {
    expect(formatCountdown(4 * 60_000 + 32_000)).toBe('4:32');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('权限的说明来自 SCOPES，拆成两段', () => {
    expect(scopeText('read')).toEqual({ head: '读图库', detail: '列表、详情、计数' });
    expect(scopeText('ui')).toEqual({ head: '界面上的小动作', detail: '标记看过' });
    expect(scopeText('history')).toEqual({ head: SCOPES.history, detail: null });
    for (const s of DEVICE_GRANTABLE_SCOPES) {
      const { head, detail } = scopeText(s);
      expect(`${head}${detail ?? ''}`.length).toBeGreaterThan(0);
      expect(SCOPES[s].startsWith(head)).toBe(true);
    }
  });

  it('可以另外勾的不含管理设备、在电脑屏幕上弹窗（永远不给）', () => {
    expect(EXTRA_SCOPES).toEqual(['organize-files', 'settings', 'rules', 'duplicates', 'jobs', 'import']);
    const html = renderToStaticMarkup(<ScopePicker value={DEVICE_DEFAULT_SCOPES} onChange={() => {}} />);
    expect(html.match(/role="checkbox"/g)).toHaveLength(DEVICE_GRANTABLE_SCOPES.length);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(DEVICE_DEFAULT_SCOPES.length);
    expect(html).not.toContain(SCOPES.devices.slice(0, 6));
    expect(html).not.toContain(SCOPES.desktop.slice(0, 6));
  });

  it('设备的权限一句话', () => {
    expect(describeScopes(DEVICE_DEFAULT_SCOPES)).toBe('默认权限');
    expect(describeScopes([...DEVICE_DEFAULT_SCOPES].reverse())).toBe('默认权限');
    expect(describeScopes([...DEVICE_DEFAULT_SCOPES, 'settings', 'jobs'] as Scope[])).toBe('默认权限 + 2 项');
    expect(describeScopes(['read', 'curate'])).toBe('2 项权限');
  });

  it('最后访问：相对时间 + 地址；没用过写「还没连接过」', () => {
    expect(lastSeenText({ lastSeenAt: null, lastAddress: null })).toBe('还没连接过');
    expect(lastSeenText({ lastSeenAt: iso(NOW - 3 * 60_000), lastAddress: '192.168.1.23' }, NOW)).toBe('3分钟前 · 192.168.1.23');
  });
});

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('设置 →「手机访问」静态渲染', () => {
  it('关着：只有开关和说明', () => {
    const html = render(<AccessBody status={status({ enabled: false, listening: false })} />);
    expect(html).toContain('让手机连接这台电脑');
    expect(html).toContain('打开后手机上的 Emaki App 能在局域网里找到这台电脑，连接要你在这里批准。');
    expect(html).toContain('aria-checked="false"');
    for (const t of ['等你批准的请求', '已连接的设备', '电脑名称', '端口']) expect(html).not.toContain(t);
  });

  it('关着但有批准过的设备：设备照样列出来，可以移除', () => {
    const html = render(<AccessBody status={status({ enabled: false, listening: false, devices: [device()] })} />);
    expect(html).toContain('已连接的设备');
    expect(html).toContain('我的 Pixel');
    expect(html).not.toContain('等你批准的请求');
  });

  it('开着、没有设备：端口、地址、防火墙提醒、名称、端口、二维码，两段都是友好的空状态', () => {
    const html = render(<AccessBody status={status()} />);
    for (const t of [
      '正在监听端口 5175',
      'https://192.168.1.5:5175',
      '要允许「专用网络」',
      '留空恢复成「DESKTOP-EMAKI」',
      'placeholder="DESKTOP-EMAKI"',
      'value="5175"',
      '显示二维码',
      '等你批准的请求',
      '现在没有',
      '已连接的设备',
      '还没有。批准过的手机会列在这里',
    ])
      expect(html).toContain(t);
  });

  it('出错（端口被占用）：醒目地写出来', () => {
    const html = render(<AccessBody status={status({ listening: false, error: '端口 5175 已被占用，换一个端口试试' })} />);
    expect(html).toContain('没能打开');
    expect(html).toMatch(/role="alert"[^>]*>.*端口 5175 已被占用，换一个端口试试/);
  });

  it('等批准的请求：名称、型号、地址、大号 3 + 3 校验码、剩余时间、批准 / 拒绝，权限默认折叠', () => {
    const html = render(<AccessBody status={status({ requests: [req('r1', { expiresAt: iso(Date.now() + 120_000) })] })} />);
    for (const t of ['Pixel 7', 'Chrome · Android 14 · 来自 192.168.1.23', '123 456', 'aria-label="校验码 1 2 3 4 5 6"', '还剩', '批准', '拒绝'])
      expect(html).toContain(t);
    expect(html).toContain('权限：默认权限');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="checkbox"');
  });

  it('已连接的设备：名称、型号、最后访问和地址、权限，编辑 / 移除', () => {
    const scopes: Scope[] = [...DEVICE_DEFAULT_SCOPES, 'settings'];
    const d = device({ lastSeenAt: iso(Date.now() - 60 * 60_000), lastAddress: '192.168.1.23', scopes });
    const html = render(<AccessBody status={status({ devices: [d] })} />);
    for (const t of ['我的 Pixel', 'Chrome · Android 14', '1小时前 · 192.168.1.23', '默认权限 + 1 项', '编辑', '移除']) expect(html).toContain(t);
  });
});

describe('二维码', () => {
  it('画成一条 path，内容一样画出来就一样；外面是浅底（深色主题下也是）', () => {
    const uri = `emaki://pair?id=${'a'.repeat(32)}&fp=${'b'.repeat(64)}&p=5175&h=192.168.1.5&t=${'c'.repeat(22)}`;
    const a = renderToStaticMarkup(<QrCode text={uri} />);
    expect(a).toMatch(/^<svg viewBox="0 0 (\d+) \1"/);
    expect(a).toContain('fill="currentColor"');
    expect(renderToStaticMarkup(<QrCode text={uri} />)).toBe(a);
    expect(renderToStaticMarkup(<QrCode text={`${uri}x`} />)).not.toBe(a);
    const ticket = { uri, expiresAt: iso(Date.now() + 90_000) };
    const view = render(<TicketView ticket={ticket} pending={false} failed={false} onRefresh={() => {}} />);
    expect(view).toContain('data-theme="light"');
    expect(view).toMatch(/还剩 1:[23]\d · 只能用一次/);
  });

  it('过期了：变淡、写「二维码过期了」，给「刷新」', () => {
    const ticket = { uri: 'emaki://pair', expiresAt: iso(Date.now() - 1) };
    const html = render(<TicketView ticket={ticket} pending={false} failed={false} onRefresh={() => {}} />);
    expect(html).toContain('二维码过期了');
    expect(html).toContain('刷新');
    expect(html).toContain('opacity-15');
  });
});
