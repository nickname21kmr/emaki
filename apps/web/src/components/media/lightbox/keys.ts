/** 焦点在这些里面时键归它们：菜单 / 弹出框、助手附页、看图器里再打开的对话框（成册、收进组图） */
export const KEYS_BELONG_TO = '[data-radix-popper-content-wrapper], [data-assistant-sheet], [role=dialog]:not([data-lightbox-root]), [role=alertdialog]';

/**
 * 翻页键（空格、PageDown / PageUp、Home / End）这一下归不归看图器。
 * 这几个键在控件上本来有用（空格是按按钮，PageDown 是滚信息面板），所以不归看图器时什么都不做、也不拦默认行为：
 * - 别人已经接了（比如菜单按钮自己处理了空格）；
 * - 焦点在菜单 / 弹出框、助手附页里；
 * - 用 Tab 把焦点放到了某个控件上（tabbing）。鼠标点过的按钮不算：点完「收藏」再按空格还是下一张，不会又点一次。
 *
 * 不用 :focus-visible 判断：Chromium 里只要按下一个键，鼠标点过的按钮也马上算 :focus-visible，在 keydown 里看到的已经是 true。
 */
export function ownsPageKey(e: Pick<KeyboardEvent, 'defaultPrevented' | 'target'>, tabbing: boolean): boolean {
  if (e.defaultPrevented) return false;
  const el = e.target as Partial<Pick<Element, 'closest' | 'matches'>> | null;
  if (!el?.closest || !el.matches) return true;
  if (el.closest(KEYS_BELONG_TO)) return false;
  // 焦点在看图器本身（刚打开、点过图片）或者丢了（body）：没有哪个控件在等这个键
  return !tabbing || el.matches('body, [data-lightbox-root]');
}
