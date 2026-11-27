/**
 * 插件视图放进 iframe 之前（docs/plugins.md 第 5 节、12.1 ①）：
 * - iframe 只开 allow-scripts、不开 allow-same-origin，视图是匿名来源，碰不到 Emaki 页面的 Cookie、存储和 DOM，视图之间也互相碰不到；
 * - 用 srcdoc 放 HTML，宿主在最前面加一条安全策略（<meta http-equiv="Content-Security-Policy">）：不能联网，
 *   脚本只能是内联的和宿主给的 /plugin-sdk/，图片只能是宿主发的短期地址（/api/plugin-media/）和 data:、blob:。
 *   页面里再写的安全策略只会更严（几条一起生效），放不宽这一条；
 * - 主题：把 Emaki 的颜色、字体、圆角换成 MCP Apps 的标准 CSS 变量（--color-background-primary 这些）交给视图。
 */
import type { McpUiStyles, McpUiTheme } from '@modelcontextprotocol/ext-apps/app-bridge';

/** 视图的安全策略：origin 是 Emaki 网页的来源（视图里写 /plugin-sdk/app.js 这种相对地址，按它解析） */
export function viewCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${origin}/plugin-sdk/`,
    "style-src 'unsafe-inline'",
    `img-src ${origin}/api/plugin-media/ data: blob:`,
    `media-src ${origin}/api/plugin-media/ data: blob:`,
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * 视图的 HTML → iframe 的 srcdoc：安全策略放在最前面（doctype 之后、任何脚本之前）。
 * 写在 <html> 之前的 <meta> 会被解析器放进隐含的 <head>，后面页面自己的 <html>、<head> 合并进来，不影响它生效
 */
export function viewSrcdoc(html: string, origin: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${viewCsp(origin)}">`;
  const m = DOCTYPE.exec(html);
  return m ? `${m[0]}${meta}${html.slice(m[0].length)}` : `<!doctype html>${meta}${html}`;
}

/** Emaki 的设计变量（--c-*，styles/index.css）→ MCP Apps 的标准变量；值在显示视图的那个元素上取（跟着浅色 / 深色） */
const COLOR_MAP: Record<string, string> = {
  '--color-background-primary': '--c-sheet',
  '--color-background-secondary': '--c-raised',
  '--color-background-tertiary': '--c-sunken',
  '--color-background-inverse': '--c-ink',
  '--color-background-info': '--c-sunken',
  '--color-background-danger': '--c-danger-soft',
  '--color-background-success': '--c-ok-soft',
  '--color-background-warning': '--c-warn-soft',
  '--color-background-disabled': '--c-sunken',
  '--color-text-primary': '--c-fg',
  '--color-text-secondary': '--c-fg-muted',
  '--color-text-tertiary': '--c-fg-subtle',
  '--color-text-inverse': '--c-fg-inverse',
  '--color-text-ghost': '--c-fg-subtle',
  '--color-text-info': '--c-shu',
  '--color-text-danger': '--c-danger',
  '--color-text-success': '--c-ok',
  '--color-text-warning': '--c-warn',
  '--color-text-disabled': '--c-fg-subtle',
  '--color-border-primary': '--c-line',
  '--color-border-secondary': '--c-line-strong',
  '--color-border-tertiary': '--c-rule',
  '--color-border-inverse': '--c-ink',
  '--color-border-info': '--c-shu',
  '--color-border-danger': '--c-danger',
  '--color-border-success': '--c-ok',
  '--color-border-warning': '--c-warn',
  '--color-border-disabled': '--c-line',
  '--color-ring-primary': '--c-ink',
  '--color-ring-secondary': '--c-line-strong',
  '--color-ring-inverse': '--c-fg-inverse',
  '--color-ring-info': '--c-shu',
  '--color-ring-danger': '--c-danger',
  '--color-ring-success': '--c-ok',
  '--color-ring-warning': '--c-warn',
};

const FIXED: Record<string, string> = {
  '--color-background-ghost': 'transparent',
  '--color-border-ghost': 'transparent',
  '--border-radius-xs': '6px',
  '--border-radius-sm': '8px',
  '--border-radius-md': '12px',
  '--border-radius-lg': '16px',
  '--border-radius-xl': '22px',
  '--border-radius-full': '9999px',
  '--border-width-regular': '1px',
  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',
  '--font-text-xs-size': '12px',
  '--font-text-sm-size': '13px',
  '--font-text-md-size': '14px',
  '--font-text-lg-size': '16px',
  '--font-heading-xs-size': '14px',
  '--font-heading-sm-size': '16px',
  '--font-heading-md-size': '18px',
  '--font-heading-lg-size': '20px',
  '--font-heading-xl-size': '24px',
  '--font-heading-2xl-size': '28px',
  '--font-heading-3xl-size': '32px',
  '--font-text-xs-line-height': '1.5',
  '--font-text-sm-line-height': '1.6',
  '--font-text-md-line-height': '1.6',
  '--font-text-lg-line-height': '1.5',
  '--font-heading-xs-line-height': '1.4',
  '--font-heading-sm-line-height': '1.4',
  '--font-heading-md-line-height': '1.35',
  '--font-heading-lg-line-height': '1.3',
  '--font-heading-xl-line-height': '1.25',
  '--font-heading-2xl-line-height': '1.2',
  '--font-heading-3xl-line-height': '1.15',
};

/** 显示视图的元素现在的主题 */
export const themeOf = (el: Element): McpUiTheme => (el.closest('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

/** 交给视图的 CSS 变量（MCP Apps 的 styles.variables） */
export function hostStyles(el: Element): McpUiStyles {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const out: Record<string, string> = { ...FIXED };
  for (const [k, from] of Object.entries(COLOR_MAP)) {
    const value = v(from);
    if (value) out[k] = value;
  }
  out['--font-sans'] = v('--font-sans') || 'system-ui, sans-serif';
  out['--font-mono'] = v('--font-mono') || 'ui-monospace, monospace';
  const line = v('--c-line');
  out['--shadow-hairline'] = line ? `0 0 0 1px ${line}` : 'none';
  out['--shadow-sm'] = v('--shadow-card') || 'none';
  out['--shadow-md'] = v('--shadow-lift') || 'none';
  out['--shadow-lg'] = v('--shadow-pop') || 'none';
  return out as McpUiStyles;
}
