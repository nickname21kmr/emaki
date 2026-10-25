/**
 * 撤销栈的「在哪、什么时候」：记录每一步是在哪个页面做的，Ctrl+Z 撤别的页面的、或者太久以前的操作前先问一声。
 * 这里只放纯函数，方便测试；真正弹提示、撤销的在 lib/queries.ts。
 */
import type { UndoEntry } from './stores';

/** 超过这么久的操作，撤销前先问 */
export const CONFIRM_AFTER_MS = 2 * 60_000;

/** 路径 → 短页名（侧栏上的叫法） */
export function pageName(path: string): string {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return '首页';
  if (p === '/gallery') return '图库';
  if (p === '/characters') return '角色';
  if (p.startsWith('/characters/')) return '角色详情';
  if (p.startsWith('/works/')) return '作品';
  if (p === '/unrecognized') return '未识别';
  if (p === '/duplicates') return '重复';
  if (p === '/collections') return '合集';
  if (p.endsWith('/read')) return '阅读器';
  if (p.startsWith('/collections/')) return '合集详情';
  if (p === '/annex' || p.startsWith('/annex/')) return '别册';
  if (p === '/excluded') return '已排除';
  if (p === '/settings') return '设置';
  if (p === '/welcome') return '欢迎页';
  if (p.startsWith('/dev')) return '开发页';
  return '首页';
}

/** 记下当前在哪：path 用来比较是不是同一页，href 带上查询参数，「去看看」时回到原样 */
export function currentPlace(): Pick<UndoEntry, 'path' | 'href' | 'page' | 'at'> {
  const loc = typeof window !== 'undefined' ? window.location : null;
  const path = loc?.pathname ?? '/';
  return { path, href: path + (loc?.search ?? ''), page: pageName(path), at: Date.now() };
}

const norm = (p: string) => p.replace(/\/+$/, '') || '/';

/** 这一步是不是在这个页面做的；没记位置的旧记录当成本页 */
export const madeHere = (e: UndoEntry, path: string) => !e.path || norm(e.path) === norm(path);

/** Ctrl+Z 之前要不要先问：别的页面做的，或者超过 2 分钟。撤销不了的占位只是提示一句，不用问 */
export function needsConfirm(e: UndoEntry, path: string, now = Date.now()): boolean {
  if (e.barrier) return false;
  if (!madeHere(e, path)) return true;
  return e.at !== undefined && now - e.at > CONFIRM_AFTER_MS;
}

/** 「刚刚」「3 分钟前」「2 小时前」 */
export function agoText(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return '之前';
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86_400)} 天前`;
}

/** 确认提示的那句话：「撤销 3 分钟前在「重复」页的操作：全部保留？」 */
export function confirmText(e: UndoEntry, path: string, now = Date.now()): string {
  const where = madeHere(e, path) ? '' : `在「${e.page ?? pageName(e.path ?? '/')}」页`;
  const ago = agoText(e.at, now);
  // 数字两边留空格，「刚刚」不留
  return `撤销${/^\d/.test(ago) ? ` ${ago}` : ago}${where}的操作：${e.label}？`;
}

/** 撤销回来的图里，按列表顺序第一张已经在列表里的：光标落到它上面；都还没出现就是 null */
export function pickRevealed(list: readonly string[], want: readonly string[]): { id: string; index: number } | null {
  if (!want.length) return null;
  const wanted = new Set(want);
  const index = list.findIndex((id) => wanted.has(id));
  return index < 0 ? null : { id: list[index]!, index };
}

/** 顶栏撤销按钮的提示后面补一句「· 重复页 · 3 分钟前」 */
export function placeText(e: UndoEntry, now = Date.now()): string {
  if (!e.path && e.at === undefined) return '';
  const parts = [e.path ? `${e.page ?? pageName(e.path)}页` : '', e.at !== undefined ? agoText(e.at, now) : ''].filter(Boolean);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}
