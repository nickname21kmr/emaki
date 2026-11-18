/**
 * 缓存回收（P4a，附录 #23：缩略图、动图缓存、替换备份以前从不清理）。缩略图、动图缓存是分析模块的派生数据，按 sha256 存：
 *   <dataDir>/thumbs/v1/<sha 前两位>/<sha>_<240|480|960>.webp
 *   <dataDir>/animations/v1/<sha 前两位>/<sha>.webp
 * 文件内容换了 sha 就变，旧 sha 的文件没人引用了就该删。替换备份见 library/replace.ts 的 collectReplacementBackups。
 *
 * 安全规则（只能删数据目录下的缓存文件，绝不碰用户图库里的文件）：
 * - 只进这两个固定的缓存目录；它们的真实位置必须在数据目录里面，并且和任何图库文件夹（包括停用、移除了的）不重叠，否则整个不做；
 * - 只看「两位十六进制」的子目录、名字完全符合上面格式且前两位和目录名一致的普通文件；符号链接、别的名字、别的东西一概不碰；
 * - 只删没有任何图片行引用的 sha（回收站里的、丢失的行也算引用：已处理的重复组还要显示被删的图），还在等撤销的替换备份的原版本也留着；
 * - 回收开始之后才写的文件不删（正在生成的缩略图）；
 * - 图库里一张图都没有、或者有图库文件夹还从没扫完过时不做：库刚重建、缓存还在的情况，扫完会接着用这些缓存。
 */
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../db/connection.ts';

/** 缓存目录（相对数据目录）和其中文件名的格式 */
export const CACHE_DIRS = [
  { kind: 'thumbs', rel: path.join('thumbs', 'v1'), file: /^([0-9a-f]{64})_(?:240|480|960)\.webp$/ },
  { kind: 'animations', rel: path.join('animations', 'v1'), file: /^([0-9a-f]{64})\.webp$/ },
] as const;

const SHARD = /^[0-9a-f]{2}$/;

/** a 在 b 里面（或就是 b） */
function within(a: string, b: string): boolean {
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 能不能动这个缓存目录：在数据目录里，和图库文件夹不重叠 */
export function safeCacheDir(dataDir: string, rel: string, roots: readonly string[]): string | null {
  const dataReal = real(dataDir);
  const dir = path.join(dataDir, rel);
  const dirReal = real(dir);
  if (!dataReal || !dirReal || !within(dirReal, dataReal) || dirReal === dataReal) return null;
  for (const r of roots) {
    const rootReal = real(r) ?? path.resolve(r);
    if (within(dirReal, rootReal) || within(rootReal, dirReal)) return null;
  }
  return dirReal;
}

export interface CacheGcOptions {
  /** 另外要留着的 sha（还在等撤销的替换备份的原版本） */
  keep?: ReadonlySet<string>;
  /** 所有图库文件夹的路径（包括停用、移除了的）：缓存目录不能和它们重叠 */
  roots: readonly string[];
  /** 回收开始的时间（毫秒）：之后才写的文件不删。默认现在 */
  startedAt?: number;
}

/** 删掉没人引用的缩略图、动图缓存；返回删了几个。不该做（见文件头）时返回 null */
export async function collectCaches(db: Db, dataDir: string, opts: CacheGcOptions): Promise<{ thumbs: number; animations: number } | null> {
  const startedAt = opts.startedAt ?? Date.now();
  if (!(db.prepare('SELECT 1 FROM images LIMIT 1').get())) return null;
  if (db.prepare('SELECT 1 FROM library_roots WHERE enabled = 1 AND removed_at IS NULL AND last_scan_at IS NULL LIMIT 1').get()) return null;
  const used = new Set(db.prepare('SELECT DISTINCT sha256 FROM images').pluck().all() as string[]);
  for (const sha of opts.keep ?? []) used.add(sha);
  const out = { thumbs: 0, animations: 0 };
  for (const c of CACHE_DIRS) {
    const dir = safeCacheDir(dataDir, c.rel, opts.roots);
    if (!dir) continue;
    let shards: string[];
    try {
      shards = readdirSync(dir);
    } catch {
      continue;
    }
    for (const shard of shards) {
      if (!SHARD.test(shard)) continue;
      const sub = path.join(dir, shard);
      try {
        const st = lstatSync(sub);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        for (const name of readdirSync(sub)) {
          const m = c.file.exec(name);
          if (!m || m[1]!.slice(0, 2) !== shard || used.has(m[1]!)) continue;
          const file = path.join(sub, name);
          const f = lstatSync(file);
          if (!f.isFile() || f.isSymbolicLink() || f.mtimeMs >= startedAt) continue;
          unlinkSync(file);
          out[c.kind]++;
        }
      } catch (error) {
        console.warn(`[缓存回收] 跳过 ${sub}：${(error as Error).message}`);
      }
      // 让出事件循环：几万个文件也不卡住 HTTP
      await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}
