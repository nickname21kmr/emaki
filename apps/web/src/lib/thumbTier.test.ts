import { describe, expect, it } from 'vitest';
import { gridThumbTier } from './thumbTier';
import { GRID_ROW_HEIGHT } from './viewport';

/** 行高 h 的一行里，比例 ratio（宽 / 高）的格子有多宽 */
const tile = (h: number, ratio: number) => h * ratio;

describe('网格缩略图档位', () => {
  it('界线：实际像素 ≤ 288 用 240，≤ 720 用 480，再宽才用 960', () => {
    expect([1, 240, 288].map((px) => gridThumbTier(px, 1))).toEqual([240, 240, 240]);
    expect([289, 480, 720].map((px) => gridThumbTier(px, 1))).toEqual([480, 480, 480]);
    expect([721, 960, 2000].map((px) => gridThumbTier(px, 1))).toEqual([960, 960, 960]);
  });

  it('电脑上默认行高 240：100% 缩放', () => {
    // 竖图 0.7、方图、4:3、16:9、2:1、3:1（justify 把比例限制在 3 以内）
    const widths = [0.7, 1, 4 / 3, 16 / 9, 2, 3].map((r) => tile(240, r));
    expect(widths.map((w) => gridThumbTier(w, 1))).toEqual([240, 240, 480, 480, 480, 480]);
  });

  it('125% 缩放：16:9、2:1 的格子留在 480（以前跳到 960）', () => {
    const widths = [0.7, 1, 4 / 3, 16 / 9, 2, 3].map((r) => tile(240, r));
    expect(widths.map((w) => gridThumbTier(w, 1.25))).toEqual([240, 480, 480, 480, 480, 960]);
  });

  it('150% 缩放：只有宽过 480 CSS 像素的格子才要 960；竖图留在 240', () => {
    const widths = [0.7, 1, 4 / 3, 16 / 9, 2, 3].map((r) => tile(240, r));
    expect(widths.map((w) => gridThumbTier(w, 1.5))).toEqual([240, 480, 480, 480, 480, 960]);
    expect(gridThumbTier(192, 1.5)).toBe(240);
    expect(gridThumbTier(193, 1.5)).toBe(480);
    expect(gridThumbTier(480, 1.5)).toBe(480);
    expect(gridThumbTier(481, 1.5)).toBe(960);
  });

  it('200% 缩放', () => {
    const widths = [0.7, 1, 4 / 3, 16 / 9, 2].map((r) => tile(240, r));
    expect(widths.map((w) => gridThumbTier(w, 2))).toEqual([480, 480, 480, 960, 960]);
    expect(gridThumbTier(144, 2)).toBe(240);
    expect(gridThumbTier(360, 2)).toBe(480);
  });

  it('手机（3 倍屏，竖屏行高 160）：竖图、4:3 用 480，16:9 才到 960', () => {
    const h = GRID_ROW_HEIGHT.compact;
    expect([0.7, 4 / 3, 16 / 9].map((r) => gridThumbTier(tile(h, r), 3))).toEqual([480, 480, 960]);
    expect(gridThumbTier(96, 3)).toBe(240);
  });

  it('放大倍数有上限：480 那档最多放大 1.5 倍，240 最多 1.2 倍', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (let w = 40; w <= 1200; w += 7) {
        const tier = gridThumbTier(w, dpr);
        const scale = (w * dpr) / tier;
        if (tier === 240) expect(scale).toBeLessThanOrEqual(1.2);
        if (tier === 480) expect(scale).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('越宽档位只升不降；取不到屏幕缩放时按 1 算', () => {
    let last = 0;
    for (let w = 10; w <= 1500; w += 10) {
      const tier = gridThumbTier(w, 1.5);
      expect(tier).toBeGreaterThanOrEqual(last);
      last = tier;
    }
    expect(gridThumbTier(300, 0)).toBe(480);
    expect(gridThumbTier(300, Number.NaN)).toBe(480);
  });
});
