import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../image/sharpConfig.ts';
import type { DedupeRow } from './DedupeService.ts';
import { findCandidates, groupCandidates } from './DedupeService.ts';
import { computeFingerprint, looksSame } from './fingerprint.ts';

/**
 * 竖版测试图：固定种子的一堆色块，细节像真实插画。
 * 大片平涂的图不适合当测试图：平坦区域相邻像素一样亮，压缩噪点会让「谁更亮」随机翻转。
 */
async function figure(file: string, seed: number) {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  let rects = '';
  for (let i = 0; i < 60; i++) {
    const c = Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0');
    rects += `<rect x="${Math.floor(rnd() * 220)}" y="${Math.floor(rnd() * 320)}" width="${10 + Math.floor(rnd() * 90)}" height="${10 + Math.floor(rnd() * 120)}" fill="#${c}"/>`;
  }
  const svg = `<svg width="240" height="340" xmlns="http://www.w3.org/2000/svg"><rect width="240" height="340" fill="#fff"/>${rects}</svg>`;
  await sharp(Buffer.from(svg)).webp({ lossless: true }).toFile(file);
}

let dir: string;
beforeAll(() => {
  dir = makeTmpDir('fp');
  mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('细指纹复核', () => {
  it('同一张图重新编码：一样；颜色完全不同的另一张：不一样', async () => {
    const a = path.join(dir, 'a.webp');
    const b = path.join(dir, 'b.webp');
    await figure(a, 1);
    await sharp(a).jpeg({ quality: 80 }).toFile(b);
    const c = path.join(dir, 'c.webp');
    await figure(c, 2);
    const [fa, fb, fc] = await Promise.all([a, b, c].map(computeFingerprint));
    expect(looksSame(fa!, fb!)).toBe(true);
    expect(looksSame(fa!, fc!)).toBe(false);
  });

  it('候选对被复核否掉就不连成组；没给复核时照旧', () => {
    const row = (id: number, dhash: string): DedupeRow => ({ id, sha256: `s${id}`, dhash, width: 100, height: 140, bytes: 1, added_at: 'x', file_name: `${id}.jpg` });
    const c = findCandidates([row(1, '26e2f07030702828'), row(2, '3272707032726828')], 8);
    expect(c.pairs).toHaveLength(1);
    expect(groupCandidates(c).groups).toHaveLength(1);
    expect(groupCandidates(c, { same: () => false, diff: () => null }).groups).toHaveLength(0);
    // 有细指纹时相似度按细的算
    expect(groupCandidates(c, { same: () => true, diff: () => 0.05 }).groups[0]!.similarity).toBeCloseTo(0.95);
  });
});
