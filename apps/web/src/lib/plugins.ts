/**
 * 插件的生效结果（docs/plugins.md 第 9 节）：服务端算好（GET /api/plugins），网页只用它——侧栏的顺序和在不在侧栏、停用的页面和区块、
 * 每个能覆盖的值（比如图片的默认排序）。还没取到时按内置插件的默认（@emaki/shared 的 builtinPluginsState，和服务端什么都没改过时一样），
 * 所以什么都没改过的人看到的和以前完全一样，不闪。
 *
 * 安全模式：地址带 ?safe 打开，这个标签页之后一直是安全模式（只用内置插件、全部按原样），?safe=0 退出。
 */
import { builtinPluginsState, type NavEntry, type NavSection, type OverrideKey, type OverrideValue, type PluginsState } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './api';
import { qk } from './queries';

const SAFE_KEY = 'emaki.safeMode';

/** 这个标签页是不是安全模式：地址里的 ?safe 优先（?safe=0 退出），否则看这个标签页之前进没进过 */
export function readSafeMode(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  const p = new URLSearchParams(search);
  const store = typeof sessionStorage === 'undefined' ? null : sessionStorage;
  if (p.has('safe')) {
    const on = p.get('safe') !== '0';
    if (on) store?.setItem(SAFE_KEY, '1');
    else store?.removeItem(SAFE_KEY);
    return on;
  }
  return store?.getItem(SAFE_KEY) === '1';
}

/** 打开页面时定一次（之后换页不变） */
const SAFE = readSafeMode();

const FALLBACK = builtinPluginsState(false);
const FALLBACK_SAFE = builtinPluginsState(true);

export interface Plugins {
  state: PluginsState;
  /** GET /api/plugins 回来了（或者取不到，按内置的默认）。会一闪而过的地方（侧栏、停用的页面）等它 */
  ready: boolean;
}

export function usePlugins(): Plugins {
  const q = useQuery({ queryKey: qk.plugins(SAFE), queryFn: () => api.plugins(SAFE), staleTime: 60_000 });
  const state = q.data ?? (SAFE ? FALLBACK_SAFE : FALLBACK);
  const ready = q.isSuccess || q.isError;
  return useMemo(() => ({ state, ready }), [state, ready]);
}

/** 侧栏的项（按你的顺序，三段）；visibleOnly：只要在侧栏显示的 */
export function useNav(): Record<NavSection, NavEntry[]> {
  return usePlugins().state.nav;
}

/** 停用的插件拥有的页面（网页的页面 id，src/pages.ts） */
export function useDisabledPages(): ReadonlySet<string> {
  const { state } = usePlugins();
  return useMemo(() => new Set(state.disabledPages), [state.disabledPages]);
}

/** 这个区块（blocks/registry.ts 的 id）是不是属于停用的插件 */
export function useDisabledBlocks(): ReadonlySet<string> {
  const { state } = usePlugins();
  return useMemo(() => new Set(state.disabledBlocks), [state.disabledBlocks]);
}

/** 停用的插件放在别处的条目（页头操作、菜单项、看图器的按钮和信息栏，blocks/slots.ts） */
export function useDisabledEntries(): ReadonlySet<string> {
  const { state } = usePlugins();
  return useMemo(() => new Set(state.disabledEntries ?? []), [state.disabledEntries]);
}

/** 一个能覆盖的值现在生效的是什么（覆盖插件给的，或者内置默认） */
export function useOverride<K extends OverrideKey>(key: K): OverrideValue<K> {
  return usePlugins().state.overrides[key].value as OverrideValue<K>;
}

/** 某个导航项现在叫什么（改过名就用改的；页头标题和侧栏一致） */
export function useNavLabel(id: string, fallback: string): string {
  const nav = useNav();
  for (const list of Object.values(nav)) for (const n of list) if (n.id === id) return n.label;
  return fallback;
}
