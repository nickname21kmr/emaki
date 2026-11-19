/**
 * 会影响查询结果的本机偏好写进 URL（docs/core-architecture.md 第 6 节「设置的归属」，附录 #32）。
 *
 * 收拢组图的模式、图库看哪些类型都是这台设备的偏好（usePrefs），但它们改变列表里有哪些图：只存在本地的话，
 * AI 助手拿到的页面上下文（地址）和用户看到的不一致。做法：URL 里写了就按 URL（助手、分享的地址、前进后退），
 * 没写就用偏好，并把偏好补进 URL（replace，不多一条历史）；用户改了就同时改偏好和 URL。
 */
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { COLLAPSE_MODES, usePrefs, type CollapseMode } from './stores';

export const COLLAPSE_PARAM = 'collapse';

const parseCollapse = (v: string | null): CollapseMode | null => (COLLAPSE_MODES.includes(v as CollapseMode) ? (v as CollapseMode) : null);

/** 当前生效的收拢模式：URL 的 ?collapse= 优先，没有就是本机偏好 */
export function useCollapseMode(): CollapseMode {
  const [params] = useSearchParams();
  const pref = usePrefs((s) => s.collapseMode);
  return parseCollapse(params.get(COLLAPSE_PARAM)) ?? pref;
}

/** 改收拢模式：偏好和 URL 一起改 */
export function useSetCollapseMode(): (mode: CollapseMode) => void {
  const [, setParams] = useSearchParams();
  const setPref = usePrefs((s) => s.setCollapseMode);
  return useCallback(
    (mode: CollapseMode) => {
      setPref(mode);
      setParams((prev) => withParam(prev, COLLAPSE_PARAM, mode), { replace: true });
    },
    [setParams, setPref],
  );
}

/** 有收拢菜单的页面调用：URL 里还没写收拢模式时把偏好补进去 */
export function useMirrorCollapseMode(): void {
  const [params, setParams] = useSearchParams();
  const pref = usePrefs((s) => s.collapseMode);
  const missing = parseCollapse(params.get(COLLAPSE_PARAM)) === null;
  useEffect(() => {
    if (!missing) return;
    setParams((prev) => (parseCollapse(prev.get(COLLAPSE_PARAM)) ? prev : withParam(prev, COLLAPSE_PARAM, pref)), { replace: true });
  }, [missing, pref, setParams]);
}

/** 返回改了一个参数的新 URLSearchParams（值一样就原样返回，不触发导航） */
export function withParam(prev: URLSearchParams, key: string, value: string): URLSearchParams {
  if (prev.get(key) === value) return prev;
  const next = new URLSearchParams(prev);
  next.set(key, value);
  return next;
}
