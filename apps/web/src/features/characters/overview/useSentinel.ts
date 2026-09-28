import { useEffect, useRef } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';

/**
 * 无限滚动的哨兵：返回的 ref 挂在列表末尾的空 div 上，进入视口（提前 800px）就调用 onReach。
 *
 * version 变化（例如已加载条数变了）会重新 observe——IntersectionObserver 只在「进出」时回调，
 * 如果加载完一页哨兵仍在视口内，不重新 observe 就不会继续加载。
 */
export function useSentinel(onReach: () => void, enabled: boolean, version: unknown) {
  const scrollRef = useScrollContainer();
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onReach);
  cb.current = onReach;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { root: scrollRef.current, rootMargin: '0px 0px 800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, scrollRef, version]);

  return ref;
}
