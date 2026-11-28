import { describe, expect, it } from 'vitest';
import { focusIsNowhere, isScrollKey, shouldFocusPaper } from './scrollFocus';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

/** 假的 DOM 节点：只有父子关系 */
class Node {
  constructor(readonly parent: Node | null = null) {}
  contains(n: unknown): boolean {
    for (let cur = n instanceof Node ? n : null; cur; cur = cur.parent) if (cur === this) return true;
    return false;
  }
}

describe('键盘滚动的焦点规则（components/layout/scrollFocus.ts）', () => {
  it('滚动键：PageDown / PageUp / Home / End / 空格 / ↑ ↓；带 Ctrl、Alt、⌘ 的不算', () => {
    for (const k of ['PageDown', 'PageUp', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']) expect(isScrollKey(key(k)), k).toBe(true);
    // 单字母快捷键、数字键跳页、左右方向键、回车、Tab 都不是
    for (const k of ['b', '2', '/', '?', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'Escape']) expect(isScrollKey(key(k)), k).toBe(false);
    expect(isScrollKey(key('Home', { ctrlKey: true }))).toBe(false);
    expect(isScrollKey(key('ArrowUp', { altKey: true }))).toBe(false);
    expect(isScrollKey(key(' ', { metaKey: true }))).toBe(false);
  });

  it('换页时：焦点哪也不在、或者还在侧栏 / 底部标签栏上，放到纸上', () => {
    const body = new Node();
    const shell = new Node(body);
    const sidebarLink = new Node(new Node(shell));
    const paper = new Node(new Node(shell));
    expect(focusIsNowhere(null, body)).toBe(true);
    expect(focusIsNowhere(body, body)).toBe(true);
    expect(shouldFocusPaper(null, body, shell, paper)).toBe(true);
    expect(shouldFocusPaper(body, body, shell, paper)).toBe(true);
    expect(shouldFocusPaper(sidebarLink, body, shell, paper)).toBe(true);
  });

  it('换页时：纸里面的输入框、挂在 body 下的对话框 / 看图器 / 助手附页里的焦点不动', () => {
    const body = new Node();
    const shell = new Node(body);
    const paper = new Node(new Node(shell));
    const searchInput = new Node(new Node(paper));
    const dialogInput = new Node(new Node(body));
    expect(shouldFocusPaper(searchInput, body, shell, paper)).toBe(false);
    expect(shouldFocusPaper(paper, body, shell, paper)).toBe(false);
    expect(shouldFocusPaper(dialogInput, body, shell, paper)).toBe(false);
  });
});
