/**
 * 手动改画师（BulkImageAction 'artist' / 'artist-auto'）的输入规范化和提示文案，mock 和 sqlite 共用，
 * 两边的提示必须一字不差（契约测试比对）。
 */
import { BadRequestError } from '../http/errors.ts';
import { normName } from '../services/danbooru/artistNames.ts';

export type ArtistEditMode = 'add' | 'remove' | 'set';

/** 标签或新名字 → 标签（小写、空格换下划线，和 Danbooru 一致）；add / remove 至少一个 */
export function normArtists(mode: ArtistEditMode, artists: string[]): string[] {
  const out = [...new Set(artists.map(normName).filter(Boolean))];
  if (!out.length && mode !== 'set') throw new BadRequestError('没有指定画师');
  return out;
}

/** names：按人去重后的显示名 */
export function artistEditMessage(mode: ArtistEditMode, n: number, names: string[]): string {
  const who = names.join('、');
  if (mode === 'add') return `已给 ${n} 张图加上画师「${who}」`;
  if (mode === 'remove') return `已从 ${n} 张图去掉画师「${who}」`;
  return names.length ? `已把 ${n} 张图的画师改成「${who}」` : `已把 ${n} 张图标成没有画师`;
}

/** reset：其中手动改过、这次改回去的张数（没改过的图不动） */
export function artistAutoMessage(n: number, reset: number): string {
  if (!reset) return n > 1 ? `这 ${n} 张图的画师本来就是自动识别的` : '这张图的画师本来就是自动识别的';
  if (reset === n) return `已把 ${n} 张图的画师改回自动识别`;
  return `已把 ${reset} 张图的画师改回自动识别（另外 ${n - reset} 张本来就是自动识别的）`;
}
