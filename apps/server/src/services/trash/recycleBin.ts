/**
 * 把文件移到系统回收站，绝不永久删除。
 * trash 10.1.1 自带的 windows-trash.exe 失败时可能不报错（recycle-bin #9），所以删除后逐个核实文件还在不在。
 * 一定要传 glob: false：默认会把 `a[1].png` 这种文件名当通配符。
 */
import { access } from 'node:fs/promises';
import trash from 'trash';

export interface TrashResult {
  trashed: string[];
  alreadyGone: string[];
  failed: { path: string; reason: string }[];
}

export type TrashImpl = (paths: string[], o: { glob: false }) => Promise<void>;

/** 按命令行长度分块（Windows 命令行最长 32767 字符）：总长 ≤ maxChars，且每块 ≤ maxCount 个 */
export function chunkPaths(paths: string[], maxChars = 28_000, maxCount = 50): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paths) {
    const l = p.length + 3; // 引号 + 空格
    if (cur.length && (len + l > maxChars || cur.length >= maxCount)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += l;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function moveToRecycleBin(absPaths: string[], impl: TrashImpl = trash): Promise<TrashResult> {
  const res: TrashResult = { trashed: [], alreadyGone: [], failed: [] };
  const existing: string[] = [];
  for (const p of absPaths) ((await exists(p)) ? existing : res.alreadyGone).push(p);
  for (const chunk of chunkPaths(existing)) {
    let err: unknown = null;
    try {
      await impl(chunk, { glob: false });
    } catch (e) {
      err = e;
    }
    // 逐个核实：文件还在 = 失败（被占用 / 没有回收站 / exe 静默失败）
    for (const p of chunk) {
      if (await exists(p)) res.failed.push({ path: p, reason: err instanceof Error ? err.message : '文件可能被其他程序占用' });
      else res.trashed.push(p);
    }
  }
  return res;
}
