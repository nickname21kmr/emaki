import { describe, expect, it, vi } from 'vitest';
import { createActionLock } from './actionLock';

describe('多选栏的动作锁', () => {
  it('同一种动作占着时拦，别的种类不拦', () => {
    const lock = createActionLock<'exclude' | 'favorite'>();
    expect(lock.any()).toBe(false);
    const release = lock.hold('exclude');
    expect(lock.held('exclude')).toBe(true);
    expect(lock.held('favorite')).toBe(false);
    expect(lock.any()).toBe(true);
    release();
    expect(lock.held('exclude')).toBe(false);
    expect(lock.any()).toBe(false);
  });

  it('放开只算一次：上一轮晚到的放开，不会把下一轮的锁放掉', () => {
    const lock = createActionLock<'exclude'>();
    // 排除第一批：请求回来就放开；整轮刷新做完时还会再调一次放开
    const first = lock.hold('exclude');
    first();
    // 马上选了第二批接着排除
    const second = lock.hold('exclude');
    first();
    expect(lock.held('exclude')).toBe(true);
    second();
    expect(lock.held('exclude')).toBe(false);
  });

  it('变化时通知（组件靠它重渲染）', () => {
    const onChange = vi.fn();
    const lock = createActionLock<'trash'>(onChange);
    const release = lock.hold('trash');
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    release();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('during：请求在路上时占着，回来就放开，失败也放开', async () => {
    const lock = createActionLock<'favorite' | 'exclude'>();
    let land!: (v: string) => void;
    const p = lock.during('favorite', new Promise<string>((r) => (land = r)));
    expect(lock.held('favorite')).toBe(true);
    land('ok');
    expect(await p).toBe('ok');
    expect(lock.held('favorite')).toBe(false);

    const failing = lock.during('exclude', Promise.reject(new Error('boom')));
    expect(lock.held('exclude')).toBe(true);
    await expect(failing).rejects.toThrow('boom');
    expect(lock.held('exclude')).toBe(false);
  });
});
