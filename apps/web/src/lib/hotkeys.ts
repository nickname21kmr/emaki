import { useEffect, useRef } from 'react';

/**
 * 简单的全局快捷键 hook。
 *
 *   useHotkey('mod+k', () => openPalette());
 *   useHotkey('e', exclude, { enabled: hasSelection });
 *
 * - `mod` = Windows 上的 Ctrl / macOS 上的 ⌘
 * - 焦点在输入框里时默认不触发（除非 allowInInputs）
 * - 按住不放时的自动重复默认不触发，免得 Enter / E 一口气处理掉好几组、好几张；
 *   翻页、换组这类要连续响应的传 repeat: true
 */
export function useHotkey(
  combo: string | string[],
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; allowInInputs?: boolean; preventDefault?: boolean; repeat?: boolean } = {},
) {
  const { enabled = true, allowInInputs = false, preventDefault = true, repeat = false } = opts;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const combos = (Array.isArray(combo) ? combo : [combo]).map(parseCombo);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const act = hotkeyAction(combos, e, { allowInInputs, repeat });
      if (act === 'skip') return;
      if (preventDefault) e.preventDefault();
      if (act === 'fire') handlerRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // combos 是由 combo 字符串派生的，用 join 作为依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allowInInputs, preventDefault, repeat, (Array.isArray(combo) ? combo : [combo]).join('|')]);
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'target'>;

/**
 * 一次 keydown 怎么处理：skip 不是这个快捷键；hold 是它，但只是按住产生的自动重复，
 * 照样拦下默认行为，不调 handler；fire 调 handler
 */
export function hotkeyAction(
  combos: readonly Combo[],
  e: KeyLike,
  opts: { allowInInputs?: boolean; repeat?: boolean } = {},
): 'skip' | 'hold' | 'fire' {
  if (!opts.allowInInputs && isTypingTarget(e.target)) return 'skip';
  if (!combos.some((c) => matches(c, e))) return 'skip';
  return e.repeat && !opts.repeat ? 'hold' : 'fire';
}

export interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKeyLabel = isMac ? '⌘' : 'Ctrl';

export function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  return { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
}

function matches(c: Combo, e: KeyLike): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (c.mod !== mod || c.shift !== e.shiftKey || c.alt !== e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === c.key || (c.key === 'space' && key === ' ') || (c.key === 'esc' && key === 'escape');
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
