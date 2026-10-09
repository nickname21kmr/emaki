import { describe, expect, it } from 'vitest';
import { annexTotal, kindTotal } from './kinds';

const counts = { illustration: 6147, comic: 1200, screenshot: 900, text: 300, photo: 200, meme: 150, animated: 56 };
const all = Object.values(counts).reduce((a, b) => a + b, 0);

describe('kindTotal', () => {
  it('图库默认只看插画：分母是插画数，不是全库', () => {
    expect(kindTotal(counts, all, ['illustration'])).toBe(6147);
  });
  it('几类一起看就加起来', () => {
    expect(kindTotal(counts, all, ['comic', 'screenshot'])).toBe(2100);
  });
  it("'all' 用全库总数", () => {
    expect(kindTotal(counts, all, 'all')).toBe(all);
  });
  it('插画 + 别册 = 全库', () => {
    expect(kindTotal(counts, all, ['illustration']) + annexTotal(counts)).toBe(all);
  });
});
