import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hotkeyAction, parseCombo } from './hotkeys';

// node 环境没有 DOM，isTypingTarget 里要用到 HTMLElement
beforeAll(() => {
  vi.stubGlobal('HTMLElement', class {});
});

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, target: null, ...extra }) as KeyboardEvent;
const combos = (...c: string[]) => c.map(parseCombo);

describe('hotkeyAction', () => {
  it('按下一次触发', () => {
    expect(hotkeyAction(combos('enter'), key('Enter'))).toBe('fire');
  });

  it('不是这个键就不管', () => {
    expect(hotkeyAction(combos('enter'), key('e'))).toBe('skip');
    expect(hotkeyAction(combos('mod+z'), key('z'))).toBe('skip');
  });

  it('按住产生的自动重复默认只拦下，不调 handler', () => {
    expect(hotkeyAction(combos('enter'), key('Enter', { repeat: true }))).toBe('hold');
    expect(hotkeyAction(combos('e'), key('E', { repeat: true }))).toBe('hold');
  });

  it('翻页类显式要了 repeat 的照常触发', () => {
    expect(hotkeyAction(combos('arrowright'), key('ArrowRight', { repeat: true }), { repeat: true })).toBe('fire');
  });
});
