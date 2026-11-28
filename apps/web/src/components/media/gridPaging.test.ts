import { describe, expect, it } from 'vitest';
import { shouldLoadMore } from './gridPaging';

const base = { hasMore: true, loadingMore: false, measured: true, ahead: 4 };

describe('网格什么时候拉下一页', () => {
  it('刚挂上、宽度还没量出来：不拉（以前这时行数是 0，-1 ≥ -4 成立，每次挂上都多拉一页）', () => {
    expect(shouldLoadMore({ ...base, measured: false, lastRendered: -1, rowCount: 0 })).toBe(false);
  });

  it('量出来了、第一屏只渲染到第 8 行，一共 18 行：不拉', () => {
    expect(shouldLoadMore({ ...base, lastRendered: 7, rowCount: 18 })).toBe(false);
  });

  it('渲染到离末尾 4 行以内：拉', () => {
    expect(shouldLoadMore({ ...base, lastRendered: 13, rowCount: 18 })).toBe(false);
    expect(shouldLoadMore({ ...base, lastRendered: 14, rowCount: 18 })).toBe(true);
    expect(shouldLoadMore({ ...base, lastRendered: 17, rowCount: 18 })).toBe(true);
  });

  it('第一页不满一屏（只有两行）也接着拉', () => {
    expect(shouldLoadMore({ ...base, lastRendered: 1, rowCount: 2 })).toBe(true);
  });

  it('第一页一张都没有、后面还有：量出来以后照样拉', () => {
    expect(shouldLoadMore({ ...base, lastRendered: -1, rowCount: 0 })).toBe(true);
  });

  it('没有下一页、或者正在拉：不拉', () => {
    expect(shouldLoadMore({ ...base, hasMore: false, lastRendered: 17, rowCount: 18 })).toBe(false);
    expect(shouldLoadMore({ ...base, hasMore: undefined, lastRendered: 17, rowCount: 18 })).toBe(false);
    expect(shouldLoadMore({ ...base, loadingMore: true, lastRendered: 17, rowCount: 18 })).toBe(false);
  });

  it('卡片网格提前 3 行', () => {
    expect(shouldLoadMore({ ...base, ahead: 3, lastRendered: 5, rowCount: 9 })).toBe(false);
    expect(shouldLoadMore({ ...base, ahead: 3, lastRendered: 6, rowCount: 9 })).toBe(true);
  });
});
