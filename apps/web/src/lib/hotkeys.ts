import { useEffect, useRef } from 'react';

/**
 * 简单的全局快捷键 hook。
 *
 *   useHotkey('mod+k', () => openPalette());
 *   useHotkey('e', exclude, { enabled: hasSelection });
 *
 * - `mod` = Windows 上的 Ctrl / macOS 上的 ⌘
 * - 焦点在输入框里时默认不触发（除非 allowInInputs）
 */
export function useHotkey(
  combo: string | string[],
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; allowInInputs?: boolean; preventDefault?: boolean } = {},
) {
  const { enabled = true, allowInInputs = false, preventDefault = true } = opts;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const combos = (Array.isArray(combo) ? combo : [combo]).map(parseCombo);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!allowInInputs && isTypingTarget(e.target)) return;
      if (combos.some((c) => matches(c, e))) {
        if (preventDefault) e.preventDefault();
        handlerRef.current(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // combos 是由 combo 字符串派生的，用 join 作为依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allowInInputs, preventDefault, (Array.isArray(combo) ? combo : [combo]).join('|')]);
}

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKeyLabel = isMac ? '⌘' : 'Ctrl';

function parseCombo(combo: string): Combo {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  return { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt') };
}

function matches(c: Combo, e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (c.mod !== mod || c.shift !== e.shiftKey || c.alt !== e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === c.key || (c.key === 'space' && key === ' ') || (c.key === 'esc' && key === 'escape');
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
