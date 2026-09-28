import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const sha256Buffer = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** 流式计算大文件的 sha256 */
export async function sha256File(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  // 不要 pipeline(stream, hash) 之后再 digest()，会抛 ERR_CRYPTO_HASH_FINALIZED
  return h.digest('hex');
}
