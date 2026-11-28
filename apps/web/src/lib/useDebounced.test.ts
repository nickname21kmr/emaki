import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from './useDebounced';

describe('搜索输入的防抖（lib/useDebounced.ts 的 createDebouncer）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const emitted: string[] = [];
    return { emitted, d: createDebouncer<string>((v) => emitted.push(v)) };
  };

  it('平时：停 delay 毫秒才给出去，连着打只给最后一个', () => {
    const { emitted, d } = setup();
    d.set('m', 200, false);
    vi.advanceTimersByTime(150);
    d.set('mi', 200, false);
    vi.advanceTimersByTime(199);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['mi']);
  });

  it('拼音输入：组合期间怎么变都不给出去，选字停多久都一样；上屏的那一刻马上给一次', () => {
    const { emitted, d } = setup();
    for (const s of ['f', 'fu', "fu'n", "fu'ning", "fu'ning'na"]) {
      d.set(s, 120, true);
      vi.advanceTimersByTime(130);
    }
    vi.advanceTimersByTime(5000);
    expect(emitted).toEqual([]);
    // 上屏：值换成汉字，组合结束
    d.set('芙宁娜', 120, false);
    expect(emitted).toEqual(['芙宁娜']);
    vi.advanceTimersByTime(5000);
    expect(emitted).toEqual(['芙宁娜']);
  });

  it('上屏之后接着打的字照常防抖', () => {
    const { emitted, d } = setup();
    d.set('mi', 200, true);
    d.set('未', 200, false);
    d.set('未1', 200, false);
    vi.advanceTimersByTime(199);
    expect(emitted).toEqual(['未']);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['未', '未1']);
  });

  it('开始组合时还等着的那次取消掉：不会在选字的时候冒出半截搜索', () => {
    const { emitted, d } = setup();
    d.set('ab', 200, false);
    vi.advanceTimersByTime(100);
    d.set('ab', 200, true);
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
    d.set('ab花', 200, false);
    expect(emitted).toEqual(['ab花']);
  });

  it('pending 为假（值已经提交过）：不给，等着的也取消；组合中取消了输入，下一次照常防抖', () => {
    const { emitted, d } = setup();
    d.set('a', 250, false);
    d.set('', 250, false, false);
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
    // 组合中按 Esc 取消：框里回到提交过的值，组合结束时没有东西要给
    d.set("hua'", 250, true);
    d.set('', 250, false, false);
    expect(emitted).toEqual([]);
    d.set('h', 250, false);
    vi.advanceTimersByTime(249);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['h']);
  });

  it('cancel 之后不再给', () => {
    const { emitted, d } = setup();
    d.set('a', 100, false);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(emitted).toEqual([]);
  });
});
