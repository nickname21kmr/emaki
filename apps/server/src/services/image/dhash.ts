import { sharp } from './sharpConfig.ts';

/** 64 位差值哈希：压平 → 缩到 9×8 灰度 → 每行相邻像素比较。返回 16 位 hex */
export async function computeDHash(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .flatten({ background: '#ffffff' }) // flatten 默认背景是黑色，透明图会变黑
    .resize(9, 8, { fit: 'fill', kernel: 'cubic' }) // fill：忽略宽高比
    .toColourspace('b-w') // 只调 greyscale() 的话仍然是 3 个相同通道
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 期望为 1，按 stride 取值更保险
  let hi = 0;
  let lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = data[(y * 9 + x) * ch]! > data[(y * 9 + x + 1) * ch]! ? 1 : 0;
      if (y < 4) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** 两个 16 位 hex dHash 的汉明距离 */
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}
