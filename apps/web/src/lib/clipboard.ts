/**
 * 复制文字。navigator.clipboard 只在安全上下文（https 或 localhost）里有，
 * 手机用局域网 http 地址打开时退回到隐藏文本框 + execCommand('copy')，需要在点击等用户操作里调用。
 * 复制不成功时抛错，调用方照旧提示「复制失败」。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('浏览器不允许访问剪贴板');
  } finally {
    ta.remove();
    active?.focus?.();
  }
}
