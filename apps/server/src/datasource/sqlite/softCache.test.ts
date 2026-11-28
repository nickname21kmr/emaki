import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDay, SoftCache } from './softCache.ts';

/** 拨动 performance.now（软窗口、最长寿命都按它算） */
function fakePerf(): { advance(ms: number): void } {
  let now = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return { advance: (ms) => void (now += ms) };
}
afterEach(() => vi.restoreAllMocks());

/** 每算一次加 1 的计数器 */
function counter() {
  let n = 0;
  return { next: () => ++n };
}

describe('SoftCache', () => {
  it('命中不重算；硬失效之后重算', () => {
    const c = new SoftCache<number>({ softMs: 10_000 });
    const k = counter();
    expect([c.get('a', k.next), c.get('a', k.next)]).toEqual([1, 1]);
    c.invalidate();
    expect(c.get('a', k.next)).toBe(2);
  });

  it('软失效：旧结果再用 softMs，过了才重算', () => {
    const perf = fakePerf();
    const c = new SoftCache<number>({ softMs: 10_000 });
    const k = counter();
    c.get('a', k.next);
    perf.advance(4_000);
    c.invalidate(true);
    expect(c.get('a', k.next)).toBe(1);
    perf.advance(6_000);
    expect(c.get('a', k.next)).toBe(2);
  });

  it('最长寿命：没人让它失效，过了 maxMs 也重算', () => {
    const perf = fakePerf();
    const c = new SoftCache<number>({ softMs: 0, maxMs: 60 * 60_000 });
    const k = counter();
    c.get('a', k.next);
    perf.advance(59 * 60_000);
    expect(c.get('a', k.next)).toBe(1);
    perf.advance(2 * 60_000);
    expect(c.get('a', k.next)).toBe(2);
  });

  it('epoch 变了重算，不变命中（本地日期：过了零点「本周新收」要重数）', () => {
    let day = 20261127;
    const c = new SoftCache<number>({ softMs: 0, epoch: () => day });
    const k = counter();
    expect([c.get('a', k.next), c.get('a', k.next)]).toEqual([1, 1]);
    day = 20261128;
    expect([c.get('a', k.next), c.get('a', k.next)]).toEqual([2, 2]);
  });

  it('只让一部分键失效：硬失效删掉认领的，别的键照样命中', () => {
    const c = new SoftCache<number>({ softMs: 10_000 });
    const k = counter();
    c.get('count:{"favorite":true}', k.next);
    c.get('count:{}', k.next);
    c.get('summary', k.next);
    c.invalidateWhere((key) => key.includes('favorite'));
    expect(c.get('count:{}', k.next)).toBe(2);
    expect(c.get('summary', k.next)).toBe(3);
    expect(c.get('count:{"favorite":true}', k.next)).toBe(4);
  });

  it('只让一部分键软失效：认领的再用 softMs，别的键不受影响', () => {
    const perf = fakePerf();
    const c = new SoftCache<number>({ softMs: 10_000 });
    const k = counter();
    c.get('a', k.next);
    c.get('b', k.next);
    perf.advance(4_000);
    c.invalidateWhere((key) => key === 'a', true);
    expect(c.get('a', k.next)).toBe(1);
    perf.advance(7_000);
    // a 算出来超过 10 秒了：重算；b 没被软失效，继续命中
    expect(c.get('a', k.next)).toBe(3);
    expect(c.get('b', k.next)).toBe(2);
    // 重算过的 a 不再带着软失效的记号
    perf.advance(11_000);
    expect(c.get('a', k.next)).toBe(3);
  });

  it('超过上限时丢掉最久没用的', () => {
    const c = new SoftCache<number>({ softMs: 0, max: 2 });
    const k = counter();
    c.get('a', k.next);
    c.get('b', k.next);
    c.get('a', k.next); // a 刚用过
    c.get('c', k.next); // 挤掉 b
    expect(c.get('a', k.next)).toBe(1);
    expect(c.get('b', k.next)).toBe(4);
  });
});

describe('localDay', () => {
  it('同一天相同，跨过本地零点不同', () => {
    const noon = new Date(2026, 10, 27, 12, 0, 0).getTime();
    expect(localDay(noon)).toBe(20261127);
    expect(localDay(new Date(2026, 10, 27, 23, 59, 59).getTime())).toBe(20261127);
    expect(localDay(new Date(2026, 10, 28, 0, 0, 1).getTime())).toBe(20261128);
  });
});
