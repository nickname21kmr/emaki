import { createContext, useContext, type RefObject } from 'react';

/**
 * 主内容区的滚动容器。虚拟列表（ImageGrid 等）需要知道「谁在滚动」。
 * AppShell 提供，页面里用 useScrollContainer() 取。
 */
export const ScrollContainerContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useScrollContainer(): RefObject<HTMLDivElement | null> {
  const ref = useContext(ScrollContainerContext);
  if (!ref) throw new Error('useScrollContainer 必须在 AppShell 内使用');
  return ref;
}
