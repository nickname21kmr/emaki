/**
 * 这台设备能做什么（docs/mobile.md 2.5、4.4）：网页按它隐藏用不了的入口——导航、路由、设置的分区、命令面板的命令、
 * 看图器和多选栏的操作。手机上看得到的都能用；电脑上（本机入口）什么都不隐藏。
 *
 * - 能力 = 权限范围（SCOPES）加上 assistant（AI 助手）。本机入口全部都有；局域网入口上的设备只有 GET /api/me 给的、
 *   真正生效的范围，其中 desktop（在电脑屏幕上弹窗）、devices（手机访问）、assistant 永远没有。
 * - 各处只声明「需要哪个能力」（need），过滤都走这里（allows / allowed / useAllowed / useAllowedActions），
 *   不在组件里判断是不是手机。页面的声明在 src/pages.ts。以后「页面可以被配置隐藏」也接在这里。
 * - 权限变了马上跟着变：服务端只给这台设备推 me 事件（lib/events.ts）；请求回 403 forbidden、SSE 重连、
 *   窗口重新获得焦点时也重新取（本机入口上权限不会变，不取）。
 * - 还没取到时按本机入口处理（can 全部为真），ready 为 false：会闪的地方（侧栏导航、路由、助手）等 ready 再渲染。
 *   取不到（连不上）也按本机入口处理，别的请求会各自报错。
 */
import { DEVICE_GRANTABLE_SCOPES, SCOPES, type Me, type Scope } from '@emaki/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { onForbidden } from './deviceAuth';
import { qk, useMe } from './queries';

export type Capability = Scope | 'assistant';
/** 一处入口需要的能力；null = 谁都能用（本机偏好、帮助这类） */
export type Need = Capability | null;

export const ALL_CAPABILITIES: readonly Capability[] = [...(Object.keys(SCOPES) as Scope[]), 'assistant'];

/** 只有电脑上（本机入口）才有的能力：设备怎么授权都没有 */
export const LOCAL_ONLY: readonly Capability[] = ['assistant', 'desktop', 'devices'];

/** 能力的集合：本机入口（或还不知道）全部；设备是它的范围和可授予范围的交集 */
export function capabilitiesOf(me: Me | null | undefined): ReadonlySet<Capability> {
  if (!me || me.kind === 'local') return new Set(ALL_CAPABILITIES);
  return new Set(me.scopes.filter((s) => DEVICE_GRANTABLE_SCOPES.includes(s)));
}

export const allows = (caps: ReadonlySet<Capability>, need: Need): boolean => need === null || caps.has(need);

/** 留下能用的（各处声明了 need 的列表都经这里过滤） */
export const allowed = <T extends { need: Need }>(items: readonly T[], caps: ReadonlySet<Capability>): T[] =>
  items.filter((i) => allows(caps, i.need));

export interface Capabilities {
  /** GET /api/me 回来了（或者取不到，按本机入口处理） */
  ready: boolean;
  /** 本机入口（还不知道时也算） */
  local: boolean;
  caps: ReadonlySet<Capability>;
  /** 能不能用；还不知道时按本机入口算（全部能用） */
  can: (need: Need) => boolean;
  /** 确定能用：/api/me 回来了而且能用。会发出请求、或者一闪而过的地方用它（助手、批准提示、侧栏导航） */
  known: (need: Need) => boolean;
}

export function capabilitiesFrom(me: Me | undefined, settled: boolean): Capabilities {
  const caps = capabilitiesOf(me);
  const can = (need: Need) => allows(caps, need);
  return { ready: settled, local: me?.kind !== 'device', caps, can, known: (need) => settled && can(need) };
}

export function useCapabilities(): Capabilities {
  const me = useMe();
  const settled = me.isSuccess || me.isError;
  return useMemo(() => capabilitiesFrom(me.data, settled), [me.data, settled]);
}

export const useCan = (need: Need): boolean => useCapabilities().can(need);

/** 不在组件里时（toast 这类）：按缓存里的 /api/me 判断；还没取到时按本机入口算 */
export const canWith = (client: QueryClient, need: Need): boolean => allows(capabilitiesOf(client.getQueryData<Me>(qk.me)), need);

/** 列表里能用的那些 */
export function useAllowed<T extends { need: Need }>(items: readonly T[]): T[] {
  const { caps } = useCapabilities();
  return useMemo(() => allowed(items, caps), [items, caps]);
}

/** 一组操作各自需要的能力 → 每个能不能用（看图器、多选栏这类按钮写在组件里的，用名字查） */
export function allowedActions<K extends string>(needs: Readonly<Record<K, Need>>, caps: ReadonlySet<Capability>): Record<K, boolean> {
  return Object.fromEntries(Object.entries(needs).map(([k, need]) => [k, allows(caps, need as Need)])) as Record<K, boolean>;
}

export function useAllowedActions<K extends string>(needs: Readonly<Record<K, Need>>): Record<K, boolean> {
  const { caps } = useCapabilities();
  return useMemo(() => allowedActions(needs, caps), [needs, caps]);
}

/** 本机入口上权限不会变：只有设备（或者还不知道是谁）才需要重新取 */
const mayChange = (client: QueryClient) => client.getQueryData<Me>(qk.me)?.kind !== 'local';

/** 权限可能变了（me 事件、SSE 重连）：重新取 /api/me */
export function refreshMe(client: QueryClient): void {
  if (mayChange(client)) void client.invalidateQueries({ queryKey: qk.me });
}

/**
 * 请求回 403 forbidden：多半是电脑上刚收回了这项权限，重新取 /api/me，入口跟着收起来。错误提示照旧（服务端的中文原因）。
 * main.tsx 挂一次，返回取消订阅
 */
export function watchForbidden(client: QueryClient): () => void {
  return onForbidden((path) => {
    // 正在取的那次已经够了（一批请求同时 403 时不来回打断它）
    if (path !== '/me' && !client.isFetching({ queryKey: qk.me })) refreshMe(client);
  });
}
