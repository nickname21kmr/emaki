import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { decodeBmp } from './bmp.ts';
import { computeDHash, hamming } from './dhash.ts';
import { computeDominantColor, processPixels, thumbPath } from './pixels.ts';
import { sharp } from './sharpConfig.ts';

/** 带纹理的测试图（纯色图的 dHash 没有意义） */
function pattern(seed: number, w: number, h: number) {
  const buf = Buffer.alloc(w * h * 3);
  const a = seed * 0.7;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.sin((x * Math.cos(a) + y * Math.sin(a)) * (0.02 + seed * 0.01)) * 0.5 + 0.5;
      const i = (y * w + x) * 3;
      buf[i] = v * 255;
      buf[i + 1] = (1 - v) * 200;
      buf[i + 2] = ((x + y) % 64) * 3;
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } });
}
const solid = (r: number, g: number, b: number, alpha = 1) =>
  sharp({ create: { width: 200, height: 200, channels: 4, background: { r, g, b, alpha } } });

describe('dHash', () => {
  it('缩小再转 JPEG 仍然接近；不同图案差得远；结果稳定', async () => {
    const a = await pattern(1, 800, 1200).png().toBuffer();
    const aSmall = await sharp(a).resize(400, 600).jpeg({ quality: 85 }).toBuffer();
    const b = await pattern(2, 800, 1200).png().toBuffer();
    const [ha, hs, hb, ha2] = await Promise.all([computeDHash(a), computeDHash(aSmall), computeDHash(b), computeDHash(a)]);
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(ha, hs)).toBeLessThanOrEqual(6);
    expect(hamming(ha, hb)).toBeGreaterThanOrEqual(20);
    expect(ha2).toBe(ha);
  });
});

describe('主色', () => {
  it('纯红', async () => {
    const hex = await computeDominantColor(await solid(255, 0, 0).png().toBuffer());
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(r).toBeGreaterThanOrEqual(240);
    expect(g).toBeLessThanOrEqual(16);
    expect(b).toBeLessThanOrEqual(16);
  });
  it('纯白走平均色分支', async () => {
    expect(await computeDominantColor(await solid(255, 255, 255).png().toBuffer())).toBe('#ffffff');
  });
});

describe('processPixels', () => {
  const root = makeTmpDir('pixels');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('长条图限高，WebP 不超上限', async () => {
    const strip = await pattern(3, 800, 20000).png().toBuffer();
    await processPixels(strip, 'png', 'aa11', root);
    const m = await sharp(thumbPath(root, 'aa11', 480)).metadata();
    expect(m.width).toBeLessThanOrEqual(480);
    expect(m.height).toBeLessThanOrEqual(3840);
  });

  it('透明 PNG 的缩略图保留透明通道', async () => {
    await processPixels(await solid(10, 200, 30, 0.5).png().toBuffer(), 'png', 'bb22', root);
    expect((await sharp(thumbPath(root, 'bb22', 480)).metadata()).hasAlpha).toBe(true);
    expect(readFileSync(thumbPath(root, 'bb22', 240)).length).toBeGreaterThan(0);
  });
});

describe('BMP', () => {
  it('解码 make-fixtures 格式的 24 位 BMP', () => {
    const w = 3;
    const h = 2;
    const rowSize = 12;
    const buf = Buffer.alloc(54 + rowSize * h);
    buf.write('BM', 0);
    buf.writeUInt32LE(54, 10);
    buf.writeInt32LE(w, 18);
    buf.writeInt32LE(h, 22);
    buf.writeUInt16LE(24, 28);
    // 自下而上：最后一行是图像第一行；左上像素设为 (r=10,g=20,b=30)，存成 BGR
    const topRow = 54 + (h - 1) * rowSize;
    buf[topRow] = 30;
    buf[topRow + 1] = 20;
    buf[topRow + 2] = 10;
    const raw = decodeBmp(buf)!;
    expect([raw.width, raw.height, raw.channels]).toEqual([3, 2, 3]);
    expect([...raw.data.subarray(0, 3)]).toEqual([10, 20, 30]);
    expect(path.basename('x')).toBe('x');
  });
});
