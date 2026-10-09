import type { ID, LibraryRoot } from '@emaki/shared';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * 「移动到文件夹」里填的路径：一般是图库文件夹里面的相对路径（角色/未花）。
 * 从资源管理器粘贴了完整路径时，落在某个图库文件夹里就换成相对路径并选中那个文件夹；
 * 不在任何图库文件夹里就报错，不发给后端（后端只会说「不能包含 :」，看不懂）。
 */
export function resolveMoveDir(
  input: string,
  roots: Pick<LibraryRoot, 'id' | 'path'>[],
): { rootId: ID | null; dir: string; error?: undefined } | { error: string } {
  // 「复制为路径」会带引号
  const p = input.trim().replace(/^"(.*)"$/, '$1').trim();
  const full = norm(p).toLowerCase();
  // 根套根时取最里面那个；Windows 路径不分大小写
  const hit = roots
    .map((r) => ({ id: r.id, base: norm(r.path) }))
    .filter(({ base }) => full === base.toLowerCase() || full.startsWith(`${base.toLowerCase()}/`))
    .sort((a, b) => b.base.length - a.base.length)[0];
  if (hit) return { rootId: hit.id, dir: norm(p).slice(hit.base.length).replace(/^\/+/, '') };
  // 盘符或网络路径，又不在图库里
  if (/^(?:[a-zA-Z]:(?:[\\/]|$)|\\\\)/.test(p)) {
    return { error: '这个路径不在图库文件夹里。只能移到上面列出的文件夹，或者写里面的相对路径，比如「角色/未花」。' };
  }
  return { rootId: null, dir: input };
}
