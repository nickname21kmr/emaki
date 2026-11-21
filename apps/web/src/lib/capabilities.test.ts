/**
 * 按权限隐藏（docs/mobile.md 4.4，lib/capabilities.ts）：
 * - 能力的计算：本机入口（和还不知道时）全有；设备按它的范围；assistant、desktop、devices 设备上永远没有；
 * - 声明了 need 的列表统一过滤；
 * - 什么时候重新取 /api/me：me 事件、SSE 重连、请求回 403 forbidden；本机入口上权限不会变，不取。
 */
import { DEVICE_DEFAULT_SCOPES, DEVICE_GRANTABLE_SCOPES, SCOPES, type Me, type Scope } from '@emaki/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canWith,
  ALL_CAPABILITIES,
  allowed,
  allowedActions,
  capabilitiesFrom,
  capabilitiesOf,
  LOCAL_ONLY,
  refreshMe,
  watchForbidden,
  type Capability,
} from './capabilities';
import { noteResponse } from './deviceAuth';
import { createInvalidator, handleServerEvent, resetEventPosition } from './events';
import { qk } from './queries';

const local: Me = { kind: 'local', scopes: Object.keys(SCOPES) as Scope[] };
const device = (scopes: readonly Scope[]): Me => ({ kind: 'device', deviceId: 'd1', name: 'Pixel 7', scopes: [...scopes] });

describe('能力的计算', () => {
  it('本机入口全部都有（含 AI 助手）；还不知道是谁时也按本机入口算', () => {
    for (const me of [local, undefined, null]) {
      const caps = capabilitiesOf(me);
      for (const c of ALL_CAPABILITIES) expect([c, caps.has(c)]).toEqual([c, true]);
    }
    expect(ALL_CAPABILITIES).toEqual([...Object.keys(SCOPES), 'assistant']);
  });

  it('设备按它的范围：默认权限有读、整理单张图、编目、合集、撤销、标记看过，没有移动文件、设置、任务……', () => {
    const caps = capabilitiesOf(device(DEVICE_DEFAULT_SCOPES));
    expect([...caps].sort()).toEqual([...DEVICE_DEFAULT_SCOPES].sort());
    for (const c of ['organize-files', 'settings', 'rules', 'duplicates', 'jobs', 'import'] as const) expect(caps.has(c)).toBe(false);
    const more = capabilitiesOf(device([...DEVICE_DEFAULT_SCOPES, 'settings']));
    expect(more.has('settings')).toBe(true);
    expect(more.has('jobs')).toBe(false);
  });

  it('assistant、desktop、devices 设备上永远没有：就算范围里写了也不算', () => {
    expect(LOCAL_ONLY).toEqual(['assistant', 'desktop', 'devices']);
    const all = capabilitiesOf(device([...(Object.keys(SCOPES) as Scope[])]));
    for (const c of LOCAL_ONLY) expect([c, all.has(c)]).toEqual([c, false]);
    expect([...all].sort()).toEqual([...DEVICE_GRANTABLE_SCOPES].sort());
  });

  it('ready / can / known：还没取到时 can 按本机入口（不闪），known 一律 false；取到了两者一致', () => {
    const pending = capabilitiesFrom(undefined, false);
    expect([pending.ready, pending.local, pending.can('devices'), pending.known('devices'), pending.known('read')]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const phone = capabilitiesFrom(device(DEVICE_DEFAULT_SCOPES), true);
    expect([phone.ready, phone.local, phone.can('read'), phone.known('read'), phone.can('settings'), phone.known('assistant')]).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    // null = 谁都能用
    expect(phone.can(null)).toBe(true);
    // 取不到（连不上）：按本机入口处理
    expect(capabilitiesFrom(undefined, true).known('assistant')).toBe(true);
  });
});

describe('声明了 need 的列表统一过滤', () => {
  const items = [
    { id: 'look', need: 'read' },
    { id: 'move', need: 'organize-files' },
    { id: 'reveal', need: 'desktop' },
    { id: 'help', need: null },
    { id: 'chat', need: 'assistant' },
  ] as const satisfies readonly { id: string; need: Capability | null }[];

  it('allowed：本机全留；默认权限的设备只留读和不要能力的', () => {
    expect(allowed(items, capabilitiesOf(local)).map((i) => i.id)).toEqual(['look', 'move', 'reveal', 'help', 'chat']);
    expect(allowed(items, capabilitiesOf(device(DEVICE_DEFAULT_SCOPES))).map((i) => i.id)).toEqual(['look', 'help']);
    expect(allowed(items, capabilitiesOf(device(['read', 'organize-files']))).map((i) => i.id)).toEqual(['look', 'move', 'help']);
  });

  it('allowedActions：按名字查', () => {
    const needs = { favorite: 'curate', trash: 'organize-files', reveal: 'desktop', info: null } as const;
    expect(allowedActions(needs, capabilitiesOf(device(DEVICE_DEFAULT_SCOPES)))).toEqual({
      favorite: true,
      trash: false,
      reveal: false,
      info: true,
    });
    expect(Object.values(allowedActions(needs, capabilitiesOf(local)))).toEqual([true, true, true, true]);
  });
});

describe('什么时候重新取 /api/me', () => {
  const setup = (me: Me | undefined) => {
    const client = new QueryClient();
    if (me) client.setQueryData(qk.me, me);
    const { invalidate } = createInvalidator(client);
    return {
      client,
      send: (e: Parameters<typeof handleServerEvent>[2]) => handleServerEvent(client, invalidate, e),
      invalid: () => client.getQueryState(qk.me)?.isInvalidated ?? false,
    };
  };
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('me 事件（电脑上改了这台设备的权限）、SSE 重连（hello）：设备上重新取；页面刚打开第一次连上不重复取', () => {
    const a = setup(device(DEVICE_DEFAULT_SCOPES));
    a.send({ type: 'me' });
    expect(a.invalid()).toBe(true);
    resetEventPosition();
    const b = setup(device(DEVICE_DEFAULT_SCOPES));
    b.send({ type: 'hello', boot: 'b1', lastId: 0 });
    expect(b.invalid()).toBe(false);
    b.send({ type: 'hello', boot: 'b1', lastId: 0 });
    expect(b.invalid()).toBe(true);
  });

  it('本机入口上权限不会变：hello、me 都不取', () => {
    const t = setup(local);
    t.send({ type: 'hello', boot: 'b1', lastId: 0 });
    t.send({ type: 'hello', boot: 'b2', lastId: 0 });
    t.send({ type: 'me' });
    expect(t.invalid()).toBe(false);
    refreshMe(t.client);
    expect(t.invalid()).toBe(false);
  });

  it('请求回 403 forbidden：设备上重新取（/api/me 自己的 403 不算，免得来回取）；别的错误不取', () => {
    const t = setup(device(DEVICE_DEFAULT_SCOPES));
    stop = watchForbidden(t.client);
    noteResponse(404, 'not_found', '/images/1');
    noteResponse(403, 'forbidden', '/me');
    expect(t.invalid()).toBe(false);
    noteResponse(403, 'forbidden', '/settings');
    expect(t.invalid()).toBe(true);
  });

  it('本机入口上的 403（比如助手没开）不取', () => {
    const t = setup(local);
    stop = watchForbidden(t.client);
    noteResponse(403, 'forbidden', '/assistant/sessions');
    expect(t.invalid()).toBe(false);
  });
});

describe('不在组件里的判断（toast 的撤销按钮）', () => {
  it('按缓存里的 /api/me：没有 history 的设备不能撤销；本机入口、还没取到时都能', () => {
    const client = new QueryClient();
    expect(canWith(client, 'history')).toBe(true);
    client.setQueryData(qk.me, { kind: 'device', deviceId: 'd', name: '手机', scopes: ['read', 'curate'] } satisfies Me);
    expect(canWith(client, 'history')).toBe(false);
    expect(canWith(client, 'curate')).toBe(true);
    client.setQueryData(qk.me, { kind: 'local', scopes: Object.keys(SCOPES) as Scope[] } satisfies Me);
    expect(canWith(client, 'history')).toBe(true);
  });
});
