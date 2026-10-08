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

/** 手动拆开 / 合并画师的提示（names：拆开时是各个标签自己的名字，合并时是被并的人；into：并到的人） */
export function artistLinksMessage(mode: 'split' | 'merge' | 'auto', names: string[], into?: string): string {
  const who = names.join('、');
  if (mode === 'split') return names.length > 1 ? `已拆开：${who} 各自算一位画师` : `已拆开：${who} 单独算一位画师`;
  if (mode === 'merge') return `已把「${who}」合并到「${into}」`;
  return `已恢复自动合并（${who}）`;
}

/** 校验 POST /api/artists/links 的标签 */
export function linkTags(tags: string[], into?: string): string[] {
  const out = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (!out.length) throw new BadRequestError('没有指定画师');
  if (into !== undefined && out.includes(into)) throw new BadRequestError('不能合并到自己');
  return out;
}

/**
 * 这次手动拆开 / 合并实际要写的标签（mock 和 sqlite 共用，groups = 标签 → 现在所在的人的代表标签）：
 * - split：只拆给的标签；给的是一个多标签的人的代表标签（这个人本身）会拆不开，报错让用户选被并进来的；
 * - merge：把这个人的全部标签都并过去（有的标签只在漫画页上，画师列表里看不到）；已经是同一个人就报错（也防止绕成环）；
 * - auto：这个人身上所有手动设置都去掉。
 */
export function planArtistLinks(mode: 'split' | 'merge' | 'auto', given: string[], into: string | undefined, groups: Map<string, string>): string[] {
  const groupOf = (t: string) => groups.get(t) ?? t;
  const members = (reps: Set<string>) => [...new Set([...given, ...[...groups].filter(([, g]) => reps.has(g)).map(([t]) => t)])];
  if (mode === 'split') {
    for (const t of given) {
      const others = [...groups].some(([x, g]) => g === t && x !== t && !given.includes(x));
      if (groupOf(t) === t && others) throw new BadRequestError(`「${t}」是这位画师本人的标签，请选被并进来的标签拆开`);
    }
    return given;
  }
  const reps = new Set(given.map(groupOf));
  if (mode === 'merge' && reps.has(groupOf(into!))) throw new BadRequestError('已经是同一位画师了');
  return members(reps);
}
