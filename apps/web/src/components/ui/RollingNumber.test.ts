import { describe, expect, it } from 'vitest';
import { isLeap, splitGlyphs } from './RollingNumber';

describe('splitGlyphs', () => {
  it('从右往左编位，逗号是静态字', () => {
    expect(splitGlyphs('1,000')).toEqual([
      { key: 'd4', char: '1', place: 3 },
      { key: 's3:,', char: ',', place: null },
      { key: 'd2', char: '0', place: 2 },
      { key: 'd1', char: '0', place: 1 },
      { key: 'd0', char: '0', place: 0 },
    ]);
  });

  it('702 → 701 只有个位的字变了', () => {
    const a = splitGlyphs('702');
    const b = splitGlyphs('701');
    expect(a.map((g) => g.key)).toEqual(b.map((g) => g.key));
    expect(a.filter((g, i) => g.char !== b[i]!.char).map((g) => g.place)).toEqual([0]);
  });

  it('9 → 10 个位 key 不变，十位是新增的', () => {
    expect(splitGlyphs('9').map((g) => g.key)).toEqual(['d0']);
    expect(splitGlyphs('10').map((g) => g.key)).toEqual(['d1', 'd0']);
  });

  it('缩写里的小数点和单位也当静态字', () => {
    expect(splitGlyphs('1.2 万').map((g) => g.place)).toEqual([1, null, 0, null, null]);
  });
});

describe('isLeap', () => {
  it('差值 > 10 且超过当前值 5% 才补间', () => {
    expect(isLeap(702, 701)).toBe(false);
    expect(isLeap(9, 10)).toBe(false);
    expect(isLeap(0, 11)).toBe(true);
    expect(isLeap(18_811, 15_000)).toBe(true);
    // 差 20 但不到 5%
    expect(isLeap(1000, 1020)).toBe(false);
  });
});
