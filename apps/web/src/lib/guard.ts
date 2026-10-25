import { useCallback, useEffect, useRef, useState } from 'react';

/** 刚处理完一条、下一条挪到鼠标下面时，它的按钮先停这么久 */
export const ARRIVAL_GUARD_MS = 400;

/**
 * 短暂的点击保护：arm() 之后 ms 毫秒内 active 为 true（按钮显示禁用），isActive() 给键盘处理即时判断用。
 *   const guard = useBriefGuard();  guard.arm();  <Button disabled={guard.active} />
 */
export function useBriefGuard(ms = ARRIVAL_GUARD_MS) {
  const [active, setActive] = useState(false);
  const until = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const arm = useCallback(() => {
    until.current = Date.now() + ms;
    setActive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(false), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const isActive = useCallback(() => Date.now() < until.current, []);
  return { active, arm, isActive };
}
