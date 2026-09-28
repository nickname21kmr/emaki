/** 图库文件相关的路径工具：扩展名、跳过规则、路径换算。 */
import path from 'node:path';

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.gif', '.avif', '.bmp']);
// 旧版 Chrome 另存推特图时得到的扩展名：a.jpg_large / a.png_orig / a.jpg-large
const TWITTER_EXT = /\.(jpe?g|png|webp|gif)[_-](large|orig|medium|small|thumb|\d+x\d+)$/i;

export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTS.has(path.extname(lower)) || TWITTER_EXT.test(lower);
}

const SKIP_DIRS = new Set(['system volume information', 'recycler', 'node_modules', '@eadir', '__macosx', '#recycle', '#snapshot']);

/** 以 . 或 $ 开头的目录（.git、.emaki-trash、$RECYCLE.BIN）以及黑名单里的目录都不进 */
export function isSkippedDirName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name.toLowerCase());
}

/** rootPath 是库里的形式（正斜杠、无结尾斜杠，但盘符根是 `D:/`）。返回平台原生路径 */
export function toAbs(rootPath: string, relPath: string): string {
  // 先补 /：path.join('D:', 'a.png') 会得到相对于 D 盘当前目录的 D:a.png
  return path.join(rootPath.endsWith('/') ? rootPath : rootPath + '/', relPath);
}

export const toRel = (rootAbs: string, abs: string) => path.relative(rootAbs, abs).split(path.sep).join('/');

export const isoFromMs = (ms: number) => new Date(Math.trunc(ms)).toISOString();

/** 路径比较键：Windows 不区分大小写 */
export function pathKey(p: string): string {
  const n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export const parentRel = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

export const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
