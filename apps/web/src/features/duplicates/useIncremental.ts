import { useEffect, useRef, useState } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';

/**
 * 分批渲染长列表：先渲染 step 个，哨兵元素滚到可视区附近再加一批。
 * 重复组可能有几百组、每组好几张图，一次全渲染会让 layout 动画和首屏都变慢。
 */
export function useIncremental(total: number, step = 20) {
  const scrollRef = useScrollContainer();
  const [count, setCount] = useState(step);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = count < total;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step);
      },
      { root: scrollRef.current, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, step, scrollRef, count]);

  /** 键盘移动到还没渲染的位置时，先把它渲染出来 */
  const ensure = (index: number) => {
    if (index >= count) setCount(Math.ceil((index + 1) / step) * step);
  };

  return { count: Math.min(count, total), hasMore, sentinelRef, ensure };
}
