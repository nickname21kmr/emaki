import { describe, expect, it } from 'vitest';
import { settleMs, slotStyle, startOffset, TRACK_GAP } from './usePageTrack';

describe('翻页轨道', () => {
  const cell = 1000;
  it('往后翻一开：刚才那一开留在原地（左开在左边一格，右开在右边一格）', () => {
    expect(startOffset(0, 1, cell, false)).toBe(cell);
    expect(startOffset(0, 1, cell, true)).toBe(-cell);
    expect(startOffset(0, -1, cell, false)).toBe(-cell);
  });
  it('手指拖到一半松手：从手指停的位置接着滑', () => {
    // 左开往左拖了 300 → 下一开已经露出 300，起点是 1000 - 300
    expect(startOffset(-300, 1, cell, false)).toBe(700);
    // 右开往右拖 300 是下一页
    expect(startOffset(300, 1, cell, true)).toBe(-700);
  });
  it('连着翻（上一次还没滑完）：最多一整格', () => {
    expect(startOffset(600, 1, cell, false)).toBe(cell);
    expect(startOffset(-600, -1, cell, false)).toBe(-cell);
  });
  it('离得越远动画越长', () => {
    expect(settleMs(cell, cell)).toBe(240);
    expect(settleMs(500, cell)).toBe(180);
    expect(settleMs(0, cell)).toBe(120);
  });
  it('格子位置：右开时下一页在左边', () => {
    expect(slotStyle(1, false).translate).toBe(`calc(1 * (100% + ${TRACK_GAP}px)) 0`);
    expect(slotStyle(1, true).translate).toBe(`calc(-1 * (100% + ${TRACK_GAP}px)) 0`);
  });
});
