/**
 * 递归遍历图库里的图片文件。手写栈而不用 readdir({ recursive: true })：
 * 后者不能剪枝（会钻进 node_modules、$RECYCLE.BIN），子目录遇到 EPERM 还会整体失败。
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isImageFile, isSkippedDirName, pathKey, toAbs } from './paths.ts';

export interface WalkEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface WalkOptions {
  /** 从哪个子目录开始（相对根，'' = 根）。这个目录不存在时什么都不列，不报 onDirError */
  startRel?: string;
  /** false = 只列 startRel 这一层 */
  recursive?: boolean;
  /** 要跳过的绝对路径：dataDir、嵌套在里面的其他图库根 */
  skipAbs?: string[];
  signal?: AbortSignal;
  onDirError?: (relDir: string, err: NodeJS.ErrnoException) => void;
}

const STAT_BATCH = 16;

export async function* walkImages(rootPath: string, o: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const skip = new Set((o.skipAbs ?? []).map(pathKey));
  const start = o.startRel ?? '';
  if (start) {
    // 起点本身或它的某一层父目录是不进的目录（.r18、$RECYCLE.BIN、@eaDir）、dataDir、嵌套的图库根：什么都不列。
    // 监听器会把这种目录的新建、改名报上来，全量扫描不进的地方增量扫描也不能进
    const segs = start.split('/');
    if (segs.some(isSkippedDirName)) return;
    for (let i = 1; i <= segs.length; i++) if (skip.has(pathKey(toAbs(rootPath, segs.slice(0, i).join('/'))))) return;
  }
  const stack = [start];
  while (stack.length) {
    if (o.signal?.aborted) return;
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(toAbs(rootPath, rel), { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // 起点（不是根）不在了：文件夹被删掉或改名走了，不算读取失败，调用方会把它下面的行判成不在（标丢失前还会逐个确认）
      if (rel === start && start && (code === 'ENOENT' || code === 'ENOTDIR')) continue;
      // EPERM / EACCES、根目录读不了、遍历途中子目录没了：跳过这个目录，由调用方记下来（它下面的行这次不判丢失）
      o.onDirError?.(rel, err as NodeJS.ErrnoException);
      continue;
    }
    const files: string[] = [];
    for (const d of entries) {
      if (d.isSymbolicLink()) continue; // Windows junction 在 Node 里也是 symlink，跳过以防成环
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (o.recursive === false || isSkippedDirName(d.name)) continue;
        if (skip.has(pathKey(toAbs(rootPath, child)))) continue;
        stack.push(child);
      } else if (d.isFile() && isImageFile(d.name)) {
        files.push(child);
      }
    }
    let statFailed = false;
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const chunk = files.slice(i, i + STAT_BATCH);
      const stats = await Promise.allSettled(chunk.map((r) => stat(toAbs(rootPath, r))));
      for (let k = 0; k < chunk.length; k++) {
        const s = stats[k]!;
        if (s.status === 'fulfilled') {
          if (s.value.isFile() && s.value.size > 0) {
            yield { relPath: chunk[k]!, bytes: s.value.size, mtimeMs: s.value.mtimeMs, birthtimeMs: s.value.birthtimeMs };
          }
        } else if (!statFailed) {
          // 列出来了却读不到信息：移动硬盘中途断开 / 休眠、文件被占用。不能当成文件没了（2026-09-29 一次扫描
          // 把 5 万张标成了丢失），这个目录按读失败报给调用方，它下面的行这次都不判丢失
          statFailed = true;
          o.onDirError?.(rel, s.reason as NodeJS.ErrnoException);
        }
      }
    }
  }
}
