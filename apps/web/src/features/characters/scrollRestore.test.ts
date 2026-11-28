import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreUnlessMoved } from './scrollRestore';

describe('角色页恢复滚动位置：用户先动了就不恢复（scrollRestore.ts）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('没人动：到点恢复一次', () => {
    const restore = vi.fn();
    restoreUnlessMoved(new EventTarget(), restore, 450);
    vi.advanceTimersByTime(449);
    expect(restore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it.each(['wheel', 'touchstart', 'keydown', 'pointerdown'])('等的时候来了 %s：这次不恢复', (type) => {
    const target = new EventTarget();
    const restore = vi.fn();
    restoreUnlessMoved(target, restore, 450);
    vi.advanceTimersByTime(200);
    target.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(5000);
    expect(restore).not.toHaveBeenCalled();
  });

  it('别的事件（滚动本身、鼠标移动）不算：后退时 AppShell 也会先恢复一次位置', () => {
    const target = new EventTarget();
    const restore = vi.fn();
    restoreUnlessMoved(target, restore, 450);
    target.dispatchEvent(new Event('scroll'));
    target.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(450);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('卸载（调返回的取消函数）后不恢复；恢复过之后的操作不再有人听', () => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, 'removeEventListener');
    const restore = vi.fn();
    const cancel = restoreUnlessMoved(target, restore, 450);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(restore).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(4);

    const again = vi.fn();
    restoreUnlessMoved(target, again, 450);
    vi.advanceTimersByTime(450);
    expect(again).toHaveBeenCalledTimes(1);
    // 到点时监听已经摘掉了
    expect(remove).toHaveBeenCalledTimes(8);
    target.dispatchEvent(new Event('wheel'));
    expect(again).toHaveBeenCalledTimes(1);
  });
});
