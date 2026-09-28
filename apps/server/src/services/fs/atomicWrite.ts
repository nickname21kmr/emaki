import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 先写临时文件再改名，避免 HTTP 读到写了一半的缩略图 */
export async function writeFileAtomic(dest: string, buf: Buffer): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, buf);
  try {
    await rename(tmp, dest);
  } catch (err) {
    // Windows：目标正被 HTTP 读取时 rename 会报 EPERM；同一 sha 内容相同，直接丢掉 tmp
    await rm(tmp, { force: true });
    if (!existsSync(dest)) throw err;
  }
}
