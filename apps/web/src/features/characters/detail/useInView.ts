import { useEffect, useRef, useState, type RefObject } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';

/**
 * 元素是否在主滚动容器（那张「纸」）的可视范围内。
 * 用 IntersectionObserver 而不是监听 scroll，滚动时零开销。
 *
 * rootMargin 例：'-72px 0px 0px 0px' = 把吸顶头部的高度扣掉。
 */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  { rootMargin = '0px', initial = true, enabled = true }: { rootMargin?: string; initial?: boolean; enabled?: boolean } = {},
): boolean {
  const scrollRef = useScrollContainer();
  const [inView, setInView] = useState(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver(([entry]) => entry && setInView(entry.isIntersecting), {
      root: scrollRef.current,
      rootMargin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, scrollRef, rootMargin, enabled]);

  return inView;
}

/** 哨兵元素进入视野时调用 onEnter（无限加载用），提前 600px 触发。 */
export function useOnEnterView<T extends Element>(onEnter: () => void, enabled: boolean) {
  const ref = useRef<T>(null);
  const cb = useRef(onEnter);
  cb.current = onEnter;
  const scrollRef = useScrollContainer();

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver(([entry]) => entry?.isIntersecting && cb.current(), {
      root: scrollRef.current,
      rootMargin: '0px 0px 600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRef, enabled]);

  return ref;
}
