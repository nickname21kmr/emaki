import { useEffect, useState } from 'react';

/** 每秒走一次的时钟；只有运行中的行才订阅（active=false 时不起定时器） */
export function useClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
