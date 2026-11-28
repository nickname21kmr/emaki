/**
 * 输入法的组合状态：拼音、假名还没上屏的那一段，输入框里是字母，不该拿去搜索、不该写进网址。
 * 在 document 上听 compositionstart / compositionend，全页一个状态；防抖搜索（lib/useDebounced.ts）和「新建角色」这类入口看它。
 *
 * 只在电脑上算数：安卓的键盘（Gboard 等）打普通英文也走组合，一个词上屏前一直是组合中，按它压住的话
 * 手机上打罗马字标签就不能边打边搜了。所以主要的指针是触屏（lib/viewport.ts 的 touch）时恒为 false，手机上和以前一样。
 */
import { useSyncExternalStore } from 'react';
import { currentViewport } from './viewport';

/** 用到的那一点事件接口（测试里给一个假的事件源） */
export interface CompositionSource {
  addEventListener(type: string, listener: (e: { isComposing?: boolean }) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: { isComposing?: boolean }) => void, capture?: boolean): void;
}

export interface ImeStore {
  /** 现在是不是在组合中（触屏上恒为 false） */
  composing(): boolean;
  /** 状态变了时调 fn，返回取消订阅 */
  subscribe(fn: () => void): () => void;
  /** 摘掉事件监听（测试用） */
  dispose(): void;
}

/**
 * source：事件从哪来（document）；isTouch：现在是不是触屏；defer：把「结束」往后放一个任务。
 * 结束要晚一个任务：火狐在 compositionend 之后还有一条 input 才把上屏的字写进输入框，等它也处理完，订阅的人看到的才是上屏后的值
 */
export function createImeStore(
  source: CompositionSource | null,
  isTouch: () => boolean,
  defer: (fn: () => void) => unknown = (fn) => setTimeout(fn, 0),
): ImeStore {
  let active = false;
  /** 每次开始 / 结束加一：排着的「结束」发现期间又开始了一段就作废 */
  let turn = 0;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    turn++;
    if (active === next) return;
    active = next;
    for (const fn of [...listeners]) fn();
  };
  const onStart = () => set(true);
  const onEnd = () => {
    const mine = ++turn;
    defer(() => {
      if (turn === mine) set(false);
    });
  };
  // 输入框在组合中被卸载（比如面板关了）时 compositionend 到不了 document：之后任何一次不在组合中的按键都说明已经结束了
  const onKeyDown = (e: { isComposing?: boolean }) => {
    if (active && e.isComposing === false) set(false);
  };
  source?.addEventListener('compositionstart', onStart, true);
  source?.addEventListener('compositionend', onEnd, true);
  source?.addEventListener('keydown', onKeyDown, true);
  return {
    composing: () => active && !isTouch(),
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    dispose() {
      source?.removeEventListener('compositionstart', onStart, true);
      source?.removeEventListener('compositionend', onEnd, true);
      source?.removeEventListener('keydown', onKeyDown, true);
      listeners.clear();
    },
  };
}

/** 全页共用的那一个 */
export const ime = createImeStore(typeof document === 'undefined' ? null : document, () => currentViewport().touch);

/** 现在是不是在用输入法组合（电脑上）；变了组件会重渲染 */
export function useImeComposing(): boolean {
  return useSyncExternalStore(ime.subscribe, ime.composing, () => false);
}
