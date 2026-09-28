/**
 * 只读文件头拿到格式和宽高，不解码像素。
 */
import type { ImageFormat } from '@emaki/shared';
import { open } from 'node:fs/promises';
import { readCameraFromExif } from './exif.ts';
import { SHARP_INPUT, sharp } from './sharpConfig.ts';

export class UnsupportedImageError extends Error {}

export interface Probe {
  format: ImageFormat;
  width: number;
  height: number;
  pages: number;
  /** 相机 'Make Model'；不是相机为 ''（T27，从 metadata 的 exif 取，不额外读盘） */
  camera: string;
}

export async function probeImage(input: Buffer | string): Promise<Probe> {
  try {
    const m = await sharp(input, SHARP_INPUT).metadata();
    const format: ImageFormat | null =
      m.format === 'jpeg' || m.format === 'png' || m.format === 'webp' || m.format === 'gif'
        ? m.format
        : m.format === 'heif' && m.compression === 'av1'
          ? 'avif' // AVIF 在 sharp 里报 format 'heif' + compression 'av1'
          : null; // HEIC(hevc)、svg、tiff、jp2… 不收
    // metadata().width 不考虑 EXIF 方向，autoOrient 里的才是显示尺寸
    const width = m.autoOrient?.width ?? m.width;
    const height = m.autoOrient?.height ?? m.height;
    if (!format || !width || !height) throw new UnsupportedImageError(`不支持的格式：${m.format}`);
    // 动图默认只读第一帧，height 是单帧高度
    return { format, width, height, pages: m.pages ?? 1, camera: format === 'jpeg' ? readCameraFromExif(m.exif) : '' };
  } catch (err) {
    const bmp = await readBmpHeader(input); // 预编译 sharp 不支持 BMP
    if (bmp) return bmp;
    throw err instanceof UnsupportedImageError ? err : new UnsupportedImageError(err instanceof Error ? err.message : String(err));
  }
}

async function readBmpHeader(input: Buffer | string): Promise<Probe | null> {
  let buf: Buffer;
  if (typeof input === 'string') {
    const fh = await open(input, 'r').catch(() => null);
    if (!fh) return null;
    try {
      buf = Buffer.alloc(26);
      const { bytesRead } = await fh.read(buf, 0, 26, 0);
      if (bytesRead < 26) return null;
    } finally {
      await fh.close();
    }
  } else {
    if (input.length < 26) return null;
    buf = input;
  }
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  return width > 0 && height > 0 ? { format: 'bmp', width, height, pages: 1, camera: '' } : null;
}
