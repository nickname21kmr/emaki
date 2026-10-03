/**
 * 查重复核用的细指纹：从 240 宽的缩略图算 16×16 dHash（256 位）和 8×8 颜色。
 * 64 位 dHash 只有 9×8 的灰度明暗，白底、中间一个竖着的人物这类构图很容易撞在一起，颜色也完全不参与比较。
 *
 * 判定规则在真实库的 3931 对相似组上校准（2026-10-04）：
 * - 细哈希距离 ≤ 68：同一张图的调色、加字、裁一点、截图多一行，基本都在这以内；70 以上抽查全是不同的图。
 * - 但距离 > 40 且颜色差 > 45（构图和颜色都差得多）也不算，比如彩图和另一张的线稿。
 * - 单看颜色不行：同一张图大幅调色后颜色差能到 56。
 */
import { sharp } from '../image/sharpConfig.ts';

export interface Fingerprint {
  /** 256 位差值哈希，32 字节 */
  fine: Buffer;
  /** 8×8 RGB，192 字节 */
  color: Buffer;
}

export const FINE_BITS = 256;
const FINE_MAX = 68;
const LOOSE_FINE = 40;
const COLOR_MAX = 45;

export async function computeFingerprint(file: string): Promise<Fingerprint> {
  const g = await sharp(file, { failOn: 'none' })
    .flatten({ background: '#ffffff' })
    .resize(17, 16, { fit: 'fill' }) // 和校准时一致，用默认的 lanczos3
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = g.info.channels;
  const fine = Buffer.alloc(32);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      if (g.data[(y * 17 + x) * ch]! > g.data[(y * 17 + x + 1) * ch]!) fine[i >> 3]! |= 0x80 >> (i & 7);
    }
  }
  const color = await sharp(file, { failOn: 'none' })
    .flatten({ background: '#ffffff' })
    .resize(8, 8, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();
  return { fine, color };
}

/** fd：细哈希的汉明距离（0–256）；cd：颜色的平均绝对差（0–255） */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): { fd: number; cd: number } {
  let fd = 0;
  for (let i = 0; i < 32; i++) {
    let x = a.fine[i]! ^ b.fine[i]!;
    while (x) {
      x &= x - 1;
      fd++;
    }
  }
  let sum = 0;
  const n = Math.min(a.color.length, b.color.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a.color[i]! - b.color[i]!);
  return { fd, cd: n ? sum / n : 0 };
}

export function looksSame(a: Fingerprint, b: Fingerprint): boolean {
  const { fd, cd } = compareFingerprints(a, b);
  return fd <= FINE_MAX && !(fd > LOOSE_FINE && cd > COLOR_MAX);
}
