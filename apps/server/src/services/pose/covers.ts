/**
 * PoseWear 姿势的线稿（封面）：仓库不带，用户自己给。找的顺序：
 * 1. 从 PoseWear 文件夹导入过的（<数据目录>/pose/posewear/{t,i}/，pose.importPoseWear 复制进来的）；
 * 2. 应用旁边的 pose-covers/（config.poseCoversDir）：PoseWear 的文件名原样放进去（full_single_P017_side.webp、pair60_P054_front.webp），
 *    平铺或者放在 t/、i/、p/t/、p/i/ 下面都认。
 * 都没有时网页按代表视角的骨架画一个小人（pose.posewearSkeleton）。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type CoverSize = 't' | 'i';

/** 姿势 id → PoseWear 里的文件名前缀（双人的类型用代表线稿的 pair60 编号） */
const sourceName = (poseId: string) => poseId.replace(/^pair_/, 'pair60_');

/** 一个文件夹里的文件名（缓存 1 秒；过了 1 秒看目录的修改时间，改了才重新读） */
const listing = new Map<string, { at: number; mtime: number; names: Set<string> }>();
/** 导入线稿之后马上忘掉缓存 */
export const forgetCoverListing = () => listing.clear();
function namesIn(dir: string): Set<string> {
  const now = Date.now();
  const c = listing.get(dir);
  if (c && now - c.at < 1000) return c.names;
  let mtime = -1;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {
    listing.set(dir, { at: now, mtime, names: new Set() });
    return new Set();
  }
  if (c && c.mtime === mtime) {
    c.at = now;
    return c.names;
  }
  let names: Set<string>;
  try {
    names = new Set(readdirSync(dir));
  } catch {
    names = new Set();
  }
  listing.set(dir, { at: now, mtime, names });
  return names;
}

export interface CoverDirs {
  /** 导入的：<数据目录>/pose/posewear */
  imported: string;
  /** 用户放的：pose-covers/ */
  covers: string;
}

/** 这个姿势、视角的线稿文件；没有是 null。大图没有时用小图，小图没有时用大图 */
export function findCover(dirs: CoverDirs, size: CoverSize, poseId: string, view: string): string | null {
  const other: CoverSize = size === 't' ? 'i' : 't';
  const own = `${poseId}_${view}.webp`;
  const src = `${sourceName(poseId)}_${view}.webp`;
  const tries: [string, string][] = [
    [path.join(dirs.imported, size), own],
    [path.join(dirs.covers, size), src],
    [path.join(dirs.covers, 'p', size), src],
    [dirs.covers, src],
    [dirs.covers, own],
    [path.join(dirs.imported, other), own],
    [path.join(dirs.covers, other), src],
    [path.join(dirs.covers, 'p', other), src],
  ];
  for (const [dir, name] of tries) if (namesIn(dir).has(name)) return path.join(dir, name);
  return null;
}

export const hasCover = (dirs: CoverDirs, poseId: string, view: string) => findCover(dirs, 't', poseId, view) !== null;
