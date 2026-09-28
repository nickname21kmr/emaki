/**
 * 像素处理：解码一次原图，写 480 + 240 缩略图，并算出主色和 dHash。
 */
import type { ImageFormat } from '@emaki/shared';
import path from 'node:path';
import type { Sharp } from 'sharp';
import { writeFileAtomic } from '../fs/atomicWrite.ts';
import { decodeBmp } from './bmp.ts';
import { computeDHash } from './dhash.ts';
import { SHARP_INPUT, sharp } from './sharpConfig.ts';

export const WEBP = { quality: 80, effort: 4, smartSubsample: true } as const;
const MAX_WEBP = 16383; // WebP 单边上限
/** 长条图同时限制高度，否则超过 WebP 上限直接报错 */
export const fitBox = (w: number) => ({
  width: w,
  height: Math.min(MAX_WEBP, w * 8),
  fit: 'inside' as const,
  withoutEnlargement: true,
});

export const thumbPath = (root: string, sha: string, w: number) => path.join(root, sha.slice(0, 2), `${sha}_${w}.webp`);

/** BMP 走自己的解码器，其余格式直接交给 sharp；统一做 EXIF 自动旋转 */
export function openSharp(input: Buffer | string, format: ImageFormat): Sharp {
  if (format === 'bmp' && Buffer.isBuffer(input)) {
    const raw = decodeBmp(input);
    if (!raw) throw new Error('不支持的 BMP 变体');
    return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
  }
  return sharp(input, SHARP_INPUT).autoOrient();
}

export interface PixelResult {
  dominantColor: string;
  dhash: string;
}

export async function processPixels(
  input: Buffer | string,
  format: ImageFormat,
  sha256: string,
  thumbsRoot: string,
): Promise<PixelResult> {
  const t480 = await openSharp(input, format).resize(fitBox(480)).webp(WEBP).toBuffer();
  await writeFileAtomic(thumbPath(thumbsRoot, sha256, 480), t480);
  const t240 = await sharp(t480).resize(fitBox(240)).webp(WEBP).toBuffer(); // 240 从 480 缩，便宜
  await writeFileAtomic(thumbPath(thumbsRoot, sha256, 240), t240);
  const [dominantColor, dhash] = await Promise.all([computeDominantColor(t240), computeDHash(t480)]);
  return { dominantColor, dhash };
}

export async function computeDominantColor(input: Buffer): Promise<string> {
  // stats() 统计的是「输入图」，所以先把压平 + 缩小后的结果写成 buffer 再统计
  const small = await sharp(input)
    .flatten({ background: '#ffffff' })
    .resize(64, 64, { fit: 'inside' })
    .toColourspace('srgb')
    .png()
    .toBuffer();
  const { dominant, channels } = await sharp(small).stats();
  const luma = 0.2126 * dominant.r + 0.7152 * dominant.g + 0.0722 * dominant.b;
  // 插画多是白底：主色接近纯白或纯黑时改用平均色，占位色才有区分度
  const c =
    luma > 235 || luma < 20
      ? { r: channels[0]!.mean, g: (channels[1] ?? channels[0])!.mean, b: (channels[2] ?? channels[0])!.mean }
      : dominant;
  return '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
