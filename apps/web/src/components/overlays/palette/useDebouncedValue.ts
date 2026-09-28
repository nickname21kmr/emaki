import { useEffect, useState } from 'react';

/** 防抖：输入停顿 delay 毫秒后才更新，避免每个按键（含输入法拼音）都打一次搜索接口 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
