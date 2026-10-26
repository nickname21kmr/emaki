import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../image/sharpConfig.ts';
import { compareImages, compatibleDecision } from './compareImages.ts';
import { ComparisonWorker } from './ComparisonWorker.ts';

let dir: string;
beforeEach(() => { dir = makeTmpDir('pixelmatch'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Smooth fills, edges and small detail cover both compression noise and concentrated edits.
const art = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024">
  <defs><linearGradient id="g"><stop stop-color="#9988aa"/><stop offset="1" stop-color="#edbb77"/></linearGradient></defs>
  <rect width="768" height="1024" fill="url(#g)"/><circle cx="380" cy="400" r="180" fill="#f5d9c9"/>
  <path d="M260 370L310 365M450 365L500 370M340 490Q380 520 420 490" stroke="#302030" stroke-width="12" fill="none"/>
  <path d="M160 1024L250 620L510 620L620 1024" fill="#495e81"/>
  <path d="M100 50L700 950M700 50L100 950" stroke="#b8c8c8" stroke-width="3"/>
</svg>`);

describe('Pixelmatch and local SSIM candidate verification', () => {
  it('identical decoded pixels despite different encoding or EXIF', async () => {
    const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.png');
    await sharp(art).png({ compressionLevel: 0 }).toFile(a);
    await sharp(art).withExif({ IFD0: { Artist: 'test' } }).png({ compressionLevel: 9 }).toFile(b);
    expect(await compareImages(a, b)).toEqual({ match: 'pixels', differentFraction: 0, localStructure: 1 });
  });

  it('recognizes a resized, recompressed copy', async () => {
    const a = path.join(dir, 'large.png'), b = path.join(dir, 'small.jpg');
    await sharp(art).png().toFile(a);
    await sharp(art).resize(384, 512).jpeg({ quality: 85 }).toFile(b);
    expect((await compareImages(a, b)).match).toBe('visual');
  });

  it.each([[1600, 400, 400, 101], [400, 1600, 101, 400]])(
    'accepts one pixel of resize rounding for %ix%i -> %ix%i',
    async (width, height, smallWidth, smallHeight) => {
      const a = path.join(dir, 'original.png'), b = path.join(dir, 'rounded-size.png');
      await sharp(art).resize(width, height, { fit: 'fill' }).png().toFile(a);
      await sharp(a).resize(smallWidth, smallHeight, { fit: 'fill' }).png().toFile(b);
      expect((await compareImages(a, b)).match).toBe('visual');
    },
  );

  it('rejects a small concentrated edit even when over 99.9% of the image is unchanged', async () => {
    const a = path.join(dir, 'a.png'), b = path.join(dir, 'closed-eye.png');
    await sharp(art).png().toFile(a);
    const patch = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#111111' } }).png().toBuffer();
    await sharp(a).composite([{ input: patch, left: 290, top: 380 }]).png().toFile(b);
    const result = await compareImages(a, b);
    expect(result.differentFraction).toBeLessThan(0.001);
    expect(result.match).toBeNull();
  });

  it('detects low-contrast stripes even when Pixelmatch reports no different pixels', async () => {
    const a = path.join(dir, 'screen.png'), b = path.join(dir, 'screen-edited.png');
    const width = 768, height = 512;
    const raw = Buffer.alloc(width * height * 3, 180);
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(a);
    for (let y = 200; y < 264; y++) for (let x = 320; x < 384; x++) {
      const value = Math.floor((y - 200) / 4) % 2 ? 195 : 165;
      raw.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(b);
    const result = await compareImages(a, b);
    expect(result.differentFraction).toBe(0);
    expect(result.localStructure).toBeLessThan(0.6);
    expect(result.match).toBeNull();
  });

  it('checks color structure separately and does not discard alpha changes', async () => {
    const a = path.join(dir, 'color.png'), b = path.join(dir, 'color-edit.png'), alpha = path.join(dir, 'alpha-edit.png');
    const width = 128, height = 128;
    const raw = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < width * height; i++) raw.set([180, 180, 180, 255], i * 4);
    await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(a);
    for (let y = 40; y < 72; y++) for (let x = 40; x < 72; x++) {
      const stripe = Math.floor(y / 4) % 2;
      raw.set(stripe ? [205, 167, 180, 255] : [155, 193, 180, 255], (y * width + x) * 4);
    }
    await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(b);
    expect((await compareImages(a, b)).match).toBeNull();
    for (let y = 40; y < 72; y++) for (let x = 40; x < 72; x++) raw[(y * width + x) * 4 + 3] = 0;
    await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(alpha);
    expect((await compareImages(b, alpha)).match).toBeNull();
  });

  it('rejects a local color-only edit even when its whole-image area is tiny', async () => {
    const a = path.join(dir, 'pink.png'), b = path.join(dir, 'recolored.png');
    const width = 512, height = 512;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) raw.set([255, 180, 255], i * 3);
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(a);
    for (let y = 200; y < 216; y++) for (let x = 200; x < 216; x++) raw[(y * width + x) * 3 + 1] = 20;
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(b);
    const result = await compareImages(a, b);
    expect(result.differentFraction).toBeLessThan(0.005);
    expect(result.maxLocalDifference).toBeGreaterThan(28);
    expect(result.match).toBeNull();
  });

  it('rechecks old visual acceptances and inherits only the unchanged rejecting pixel checks', () => {
    expect(compatibleDecision({ match: 'visual', differentFraction: 0 })).toBeNull();
    expect(compatibleDecision({ match: null, differentFraction: 0.00001, maxLocalDifference: 200 })).toEqual({ match: null, differentFraction: 0.00001, maxLocalDifference: 200 });
    expect(compatibleDecision({ match: null, differentFraction: 0.1 })).toEqual({ match: null, differentFraction: 0.1 });
    // v1 used the same sentinel for aspect rejection and a 100% pixel difference.
    expect(compatibleDecision({ match: null, differentFraction: 1, maxLocalDifference: 256 })).toBeNull();
    expect(compatibleDecision({ match: 'pixels', differentFraction: 0 })).toEqual({ match: 'pixels', differentFraction: 0, localStructure: 1 });
  });

  it('does not compare only an animation cover or stretch a crop into the original', async () => {
    const a = path.join(dir, 'still.png'), crop = path.join(dir, 'crop.png'), gif = path.join(dir, 'animated.gif');
    await sharp(art).png().toFile(a);
    await sharp(a).extract({ left: 0, top: 0, width: 700, height: 1024 }).png().toFile(crop);
    const first = await sharp(a).resize(48, 64).ensureAlpha().raw().toBuffer();
    const second = Buffer.alloc(first.length, 255);
    await sharp(Buffer.concat([first, second]), { raw: { width: 48, height: 128, channels: 4, pageHeight: 64 } }).gif({ delay: [100, 100] }).toFile(gif);
    expect((await compareImages(a, crop)).match).toBeNull();
    expect((await compareImages(gif, gif)).match).toBeNull();
  });

  it('rejects failed decodes and runs the same comparator in a worker', async () => {
    const a = path.join(dir, 'a.png'), bad = path.join(dir, 'bad.png');
    await sharp(art).png().toFile(a);
    writeFileSync(bad, 'not an image');
    await expect(compareImages(a, bad)).rejects.toThrow();
    const worker = new ComparisonWorker();
    try {
      expect((await worker.compare(a, a)).match).toBe('pixels');
      await expect(worker.compare(a, bad)).rejects.toThrow();
      expect((await worker.compare(a, a)).match).toBe('pixels');
    } finally { await worker.close(); }
  });
});
