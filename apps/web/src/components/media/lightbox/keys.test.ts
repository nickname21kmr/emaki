import { describe, expect, it } from 'vitest';
import { KEYS_BELONG_TO, ownsPageKey } from './keys';

// node 环境没有 DOM：用只有 closest / matches 的假元素，within 是它所在的容器
const el = (self: string, within = '') =>
  ({
    closest: (sel: string) => (sel === KEYS_BELONG_TO && within === 'popper' ? {} : null),
    matches: (sel: string) => sel.split(',').some((s) => s.trim() === self),
  }) as unknown as EventTarget;
const press = (target: EventTarget | null, defaultPrevented = false) => ({ target, defaultPrevented });

describe('ownsPageKey', () => {
  it('焦点在看图器本身或者丢了：翻页键归看图器', () => {
    expect(ownsPageKey(press(el('[data-lightbox-root]')), false)).toBe(true);
    expect(ownsPageKey(press(el('body')), false)).toBe(true);
    expect(ownsPageKey(press(null), false)).toBe(true);
    // 之前按过 Tab，但焦点已经回到看图器本身
    expect(ownsPageKey(press(el('[data-lightbox-root]')), true)).toBe(true);
  });

  it('鼠标点过的按钮不算键盘焦点：点完再按空格还是翻页', () => {
    expect(ownsPageKey(press(el('button')), false)).toBe(true);
  });

  it('用 Tab 停在控件上：空格、PageDown 留给它', () => {
    expect(ownsPageKey(press(el('button')), true)).toBe(false);
  });

  it('焦点在菜单 / 弹出框、助手附页里：不管怎么进去的都留给它们', () => {
    expect(ownsPageKey(press(el('[role=menuitem]', 'popper')), false)).toBe(false);
    expect(ownsPageKey(press(el('[role=menuitem]', 'popper')), true)).toBe(false);
  });

  it('别人已经处理过这一下（菜单按钮自己接了空格）：不再翻页', () => {
    expect(ownsPageKey(press(el('[data-lightbox-root]'), true), false)).toBe(false);
  });
});
