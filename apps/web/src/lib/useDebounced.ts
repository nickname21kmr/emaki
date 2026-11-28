/**
 * 搜索输入的防抖，全站一份（以前图库、命令面板、未识别、合并角色各有一份一样的）。
 * 认输入法：拼音还没上屏时输入框里是字母，这段时间不给出新值（不搜索、不写网址）；上屏的那一刻马上给出去，不再等一个防抖周期。
 * 组合状态见 lib/ime.ts（触屏上恒为「不在组合中」，手机上就是普通的防抖）。
 */
import { useEffect, useRef, useState } from 'react';
import { useImeComposing } from './ime';

export interface Debouncer<T> {
  /**
   * 值变了、或者输入法的组合状态变了时调：
   * 组合中不计时（外面看到的还是上一次给出去的值）；刚结束组合马上给出去；平时停 delay 毫秒后给出去。
   * pending 为假：现在的值不用给（已经是给出去过的那个），只把等着的那次取消
   */
  set(value: T, delay: number, composing: boolean, pending?: boolean): void;
  /** 取消等着的那次（卸载时） */
  cancel(): void;
}

/** 防抖的规则本身，不依赖 React（useDebounced.test.ts 直接测它） */
export function createDebouncer<T>(emit: (value: T) => void): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次调 set 时在组合中 */
  let held = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    set(value, delay, composing, pending = true) {
      cancel();
      const justCommitted = held && !composing;
      held = composing;
      if (composing || !pending) return;
      if (justCommitted) emit(value);
      else timer = setTimeout(() => emit(value), delay);
    },
    cancel,
  };
}

function useDebouncer<T>(emit: (value: T) => void): Debouncer<T> {
  // 调用方每次渲染都可能给新的函数，放 ref 里，计时不被无关的重渲染打断
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const ref = useRef<Debouncer<T> | null>(null);
  ref.current ??= createDebouncer<T>((value) => emitRef.current(value));
  return ref.current;
}

/** 值停止变化 delay 毫秒后才更新（搜索输入用）；输入法组合期间保持旧值，上屏后马上更新 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  const composing = useImeComposing();
  const debouncer = useDebouncer<T>(setDebounced);
  useEffect(() => debouncer.set(value, delay, composing), [debouncer, value, delay, composing]);
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  return debounced;
}

/**
 * 值停下 delay 毫秒后调 commit(value)（搜索框把草稿写进网址用）；pending 为假表示现在的值已经提交过，不用调。
 * 规则和 useDebounced 一样：输入法组合期间不调，上屏后马上调
 */
export function useDebouncedCommit<T>(value: T, delay: number, pending: boolean, commit: (value: T) => void): void {
  const composing = useImeComposing();
  const debouncer = useDebouncer(commit);
  useEffect(() => debouncer.set(value, delay, composing, pending), [debouncer, value, delay, composing, pending]);
  useEffect(() => () => debouncer.cancel(), [debouncer]);
}
