import { describe, expect, it } from 'vitest';
import { localStructure } from './localStructure.ts';

const solid = (value: number, alpha = 255) => {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) pixels.set([value, value, value, alpha], i * 4);
  return pixels;
};

describe('regional RGB SSIM', () => {
  it('matches the standard SSIM formula for two constant images', () => {
    const c1 = (0.01 * 255) ** 2;
    const expected = (2 * 100 * 200 + c1) / (100 ** 2 + 200 ** 2 + c1);
    expect(localStructure(solid(100), solid(200), 32, 32)).toBeCloseTo(expected, 9);
  });

  it('includes alpha changes independently of RGB', () => {
    expect(localStructure(solid(100), solid(100), 32, 32)).toBeCloseTo(1, 9);
    expect(localStructure(solid(100, 0), solid(100, 255), 32, 32)).toBeLessThan(0.001);
  });

  it('does not infer a visual copy from too few pixels for an SSIM window', () => {
    const a = Buffer.alloc(4 * 4 * 4, 100), b = Buffer.from(a);
    b[0] = 101;
    expect(localStructure(a, a, 4, 4)).toBe(1);
    expect(localStructure(a, b, 4, 4)).toBe(-1);
  });
});
