/**
 * 键盘滚动（PageDown / 空格 / Home / End / ↑↓）要焦点在纸上才有用：文档本身不滚，滚的是 AppShell 里那张纸，
 * 焦点在 body 或侧栏的链接上时，浏览器把这些键发给不会滚的文档。这里是「什么时候把焦点放到纸上」的规则，AppShell 用。
 */

/** 浏览器拿来滚动页面的键 */
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);

/** 是不是滚动键（带 Ctrl / Alt / ⌘ 的是别的快捷键；Shift + 空格是往上翻一屏，算） */
export const isScrollKey = (e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean =>
  !e.ctrlKey && !e.metaKey && !e.altKey && SCROLL_KEYS.has(e.key);

/** 判断时只用到 contains */
interface Container {
  contains(node: unknown): boolean;
}

/** 焦点哪也不在（没有，或者落在 body 上） */
export const focusIsNowhere = (active: unknown, body: unknown): boolean => !active || active === body;

/**
 * 换页时要不要把焦点放到纸上：焦点哪也不在，或者还留在导航上（侧栏、底部标签栏：在外壳里、但不在纸里）。
 * 纸里面的（页面自己的输入框、阅读器）、外壳外面的（对话框、菜单、看图器、助手附页都挂在 body 下）不动
 */
export function shouldFocusPaper(active: unknown, body: unknown, shell: Container, paper: Container): boolean {
  if (focusIsNowhere(active, body)) return true;
  return shell.contains(active) && !paper.contains(active);
}
