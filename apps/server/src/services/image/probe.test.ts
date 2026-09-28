import { expect, it } from 'vitest';
import { probeImage, UnsupportedImageError } from './probe.ts';
import { sharp } from './sharpConfig.ts';

const make = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 100, b: 50 } } });

it.each([
  ['png', () => make(80, 120).png().toBuffer(), { format: 'png', width: 80, height: 120 }],
  ['jpeg', () => make(120, 80).jpeg().toBuffer(), { format: 'jpeg', width: 120, height: 80 }],
  ['webp', () => make(64, 64).webp().toBuffer(), { format: 'webp', width: 64, height: 64 }],
  ['gif', () => make(50, 40).gif().toBuffer(), { format: 'gif', width: 50, height: 40 }],
  ['avif', () => make(64, 96).avif().toBuffer(), { format: 'avif', width: 64, height: 96 }],
  ['长条图', () => make(80, 20000).png().toBuffer(), { format: 'png', width: 80, height: 20000 }],
] as const)('%s', async (_name, build, expected) => {
  expect(await probeImage(await build())).toMatchObject(expected);
});

it('BMP 读文件头', async () => {
  const buf = Buffer.alloc(54 + 4 * 2 * 3);
  buf.write('BM', 0);
  buf.writeInt32LE(3, 18);
  buf.writeInt32LE(-2, 22); // 自上而下的 BMP 高度为负
  expect(await probeImage(buf)).toEqual({ format: 'bmp', width: 3, height: 2, pages: 1, camera: '' });
});

it('EXIF 方向旋转后按显示尺寸返回', async () => {
  const rotated = await make(120, 80).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  expect(await probeImage(rotated)).toMatchObject({ width: 80, height: 120 });
});

it('不是图片 → UnsupportedImageError', async () => {
  await expect(probeImage(Buffer.from('这不是一张图片'))).rejects.toBeInstanceOf(UnsupportedImageError);
});
