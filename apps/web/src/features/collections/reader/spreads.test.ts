import { describe, expect, it } from 'vitest';
import { buildSpreads, spreadIndexOf } from './spreads';

const tall = (pageNo: number) => ({ pageNo, width: 1000, height: 1400 });
const wide = (pageNo: number) => ({ pageNo, width: 1426, height: 1024 });

describe('buildSpreads', () => {
  it('封面单独、横页单独、竖页两两成对、最后剩一页单独', () => {
    expect(buildSpreads([tall(1), wide(2), tall(3), tall(4), tall(5)], true)).toEqual([[1], [2], [3, 4], [5]]);
  });
  it('横页前面落单的竖页单独一开', () => {
    expect(buildSpreads([tall(1), tall(2), wide(3), tall(4), tall(5)], true)).toEqual([[1], [2], [3], [4, 5]]);
  });
  it('单页模式每页一开', () => {
    expect(buildSpreads([tall(1), tall(2), tall(3)], false)).toEqual([[1], [2], [3]]);
  });
  it('找页所在的开', () => {
    expect(spreadIndexOf([[1], [2], [3, 4], [5]], 4)).toBe(2);
    expect(spreadIndexOf([[1]], 9)).toBe(0);
  });
});
