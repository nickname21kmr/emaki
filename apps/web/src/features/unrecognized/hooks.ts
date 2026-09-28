import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isTypingTarget } from '@/lib/hotkeys';
import { useLightbox, useOverlays } from '@/lib/stores';

/**
 * 这一页的快捷键此刻能不能响应：看图器 / 命令面板 / 帮助面板打开时一律让路。
 * 用 hook 订阅，状态变化时组件会重渲染，useHotkey 的 enabled 才能跟上。
 */
export function useTriageKeysEnabled(): boolean {
  const lightboxOpen = useLightbox((s) => s.open);
  const commandOpen = useOverlays((s) => s.commandOpen);
  const helpOpen = useOverlays((s) => s.helpOpen);
  return !lightboxOpen && !commandOpen && !helpOpen;
}

/**
 * 「抢先」快捷键：在捕获阶段监听，处理了就阻止继续传播。
 *
 * 为什么不用 useHotkey：全局快捷键把 1–5 用作跳页、`/` 用作打开命令面板，
 * 而在未识别页里它们分别是「采纳第 N 个建议」和「聚焦搜索框」。
 * 捕获阶段比全局（冒泡阶段）先执行，stopPropagation 后全局那边就收不到了。
 *
 * handler 返回 false 表示「这次不处理」，事件照常传给全局。
 */
export function usePriorityKeys(
  keys: string[],
  handler: (key: string, e: KeyboardEvent) => boolean | void,
  enabled: boolean,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const keySig = keys.join('|');

  useEffect(() => {
    if (!enabled) return;
    const wanted = new Set(keySig.split('|'));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (!wanted.has(e.key)) return;
      if (isTypingTarget(e.target)) return;
      // 弹窗 / 菜单里按键属于它们自己
      if (e.target instanceof Element && e.target.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      if (handlerRef.current(e.key, e) === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [enabled, keySig]);
}

/** 元素尺寸（ResizeObserver），用来把预览图按比例塞进可用区域。 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** 输入防抖：搜索框打字时不必每个字都请求一次 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** 按「contain」把 w×h 塞进 boxW×boxH，返回显示尺寸 */
export function fitContain(w: number, h: number, boxW: number, boxH: number) {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return { width: 0, height: 0 };
  const s = Math.min(boxW / w, boxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}
