import { describe, expect, it } from 'vitest';
import { findSimilarPairs, parseDHash, popcount32 } from './hamming.ts';

/** 可复现的伪随机（mulberry32） */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

describe('popcount32', () => {
  it('边界值', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000001)).toBe(2);
  });
});

describe('parseDHash', () => {
  it('拆成两个无符号 32 位', () => {
    expect(parseDHash('ffffffff00000001')).toEqual([0xffffffff, 1]);
  });
});

describe('findSimilarPairs', () => {
  const N = 2000;
  const r = rng(42);
  const hi = new Uint32Array(N);
  const lo = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    if (i > 0 && i % 3 === 0) {
      // 三分之一是前一条翻转若干位的近似重复
      hi[i] = hi[i - 1]!;
      lo[i] = lo[i - 1]!;
      const flips = r() % 14;
      for (let f = 0; f < flips; f++) {
        const bit = r() % 64;
        if (bit < 32) hi[i] = (hi[i]! ^ (1 << bit)) >>> 0;
        else lo[i] = (lo[i]! ^ (1 << (bit - 32))) >>> 0;
      }
    } else {
      hi[i] = r();
      lo[i] = r();
    }
  }

  for (const T of [0, 4, 8, 12, 16]) {
    it(`T=${T} 与暴力法一致`, () => {
      const brute: string[] = [];
      for (let a = 0; a < N; a++)
        for (let b = a + 1; b < N; b++) {
          const d = popcount32((hi[a]! ^ hi[b]!) >>> 0) + popcount32((lo[a]! ^ lo[b]!) >>> 0);
          if (d <= T) brute.push(`${a}-${b}-${d}`);
        }
      const got: string[] = [];
      findSimilarPairs(hi, lo, T, (a, b, d) => got.push(`${a}-${b}-${d}`));
      expect(got.sort()).toEqual(brute.sort());
      expect(brute.length).toBeGreaterThan(0);
    });
  }
});
