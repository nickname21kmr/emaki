import { describe, expect, it, vi } from 'vitest';
import { createImeStore, type CompositionSource } from './ime';

type Listener = (e: { isComposing?: boolean }) => void;

/** 假的 document：fire('compositionstart') 这样发事件；defer 排着的「下一个任务」用 tick() 跑掉 */
function setup(touch = false) {
  const handlers = new Map<string, Set<Listener>>();
  const source: CompositionSource = {
    addEventListener: (type, fn) => void (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type, fn) => void handlers.get(type)?.delete(fn),
  };
  const queue: (() => void)[] = [];
  let isTouch = touch;
  const store = createImeStore(source, () => isTouch, (fn) => queue.push(fn));
  const changes = vi.fn();
  store.subscribe(changes);
  return {
    store,
    changes,
    handlers,
    fire: (type: string, e: { isComposing?: boolean } = {}) => handlers.get(type)?.forEach((fn) => fn(e)),
    tick: () => queue.splice(0).forEach((fn) => fn()),
    setTouch: (v: boolean) => (isTouch = v),
  };
}

describe('输入法的组合状态（lib/ime.ts）', () => {
  it('compositionstart 置真并通知；compositionend 之后的下一个任务才置假并通知', () => {
    const { store, changes, fire, tick } = setup();
    expect(store.composing()).toBe(false);
    fire('compositionstart');
    expect(store.composing()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    // 组合中的按键（isComposing 为真）不影响
    fire('keydown', { isComposing: true });
    expect(store.composing()).toBe(true);
    fire('compositionend');
    // 火狐这时上屏的字还没写进输入框（后面还有一条 input）：先不变
    expect(store.composing()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    tick();
    expect(store.composing()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('连着打下一个词（结束后紧接着又开始）：中间不闪一下「不在组合中」', () => {
    const { store, changes, fire, tick } = setup();
    fire('compositionstart');
    fire('compositionend');
    fire('compositionstart');
    tick();
    expect(store.composing()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    fire('compositionend');
    tick();
    expect(store.composing()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('触屏上恒为 false（安卓键盘打英文也走组合，手机上保持边打边搜）', () => {
    const { store, fire, tick, setTouch } = setup(true);
    fire('compositionstart');
    expect(store.composing()).toBe(false);
    fire('compositionend');
    tick();
    expect(store.composing()).toBe(false);
    // 同一台设备换成鼠标之后照常
    setTouch(false);
    fire('compositionstart');
    expect(store.composing()).toBe(true);
  });

  it('没等到 compositionend（输入框在组合中被卸载）：下一次不在组合中的按键把状态纠正回来', () => {
    const { store, changes, fire } = setup();
    fire('compositionstart');
    fire('keydown', { isComposing: false });
    expect(store.composing()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    // 平时的按键不通知
    fire('keydown', { isComposing: false });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('取消订阅后不再通知；dispose 摘掉事件监听；没有 document（node）时一直是 false', () => {
    const { store, changes, handlers, fire } = setup();
    const other = vi.fn();
    const off = store.subscribe(other);
    off();
    fire('compositionstart');
    expect(other).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledTimes(1);
    store.dispose();
    expect([...handlers.values()].every((s) => s.size === 0)).toBe(true);
    expect(createImeStore(null, () => false).composing()).toBe(false);
  });
});
