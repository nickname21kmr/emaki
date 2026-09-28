import { useEffect, useLayoutEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigationType } from 'react-router';
import { Lightbox } from '@/components/media/Lightbox';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { HelpDialog } from '@/components/overlays/HelpDialog';
import { useServerEvents } from '@/lib/events';
import { useSettings } from '@/lib/queries';
import { useGlobalHotkeys } from './useGlobalHotkeys';
import { ScrollContainerContext } from './ScrollContainer';
import { Sidebar } from './Sidebar';

/**
 * 整体布局：暖灰「桌面」上左边一条窄导航，右边一张圆角「纸」（主内容，独立滚动）。
 */
export function AppShell() {
  useServerEvents();
  useGlobalHotkeys();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname, key } = useLocation();
  const navType = useNavigationType();
  const settings = useSettings().data;

  // 按历史条目记住滚动位置：后退 / 前进时恢复（SEL-14）
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const save = () => positions.current.set(key, el.scrollTop);
    el.addEventListener('scroll', save, { passive: true });
    return () => el.removeEventListener('scroll', save);
  }, [key]);

  // 切换页面回到顶部；用 layout effect，保证在 View Transition 拍新快照之前完成
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = navType === 'POP' ? positions.current.get(key) : undefined;
    if (saved === undefined) return void el.scrollTo({ top: 0 });
    // 虚拟列表要一两帧才把高度撑开：最多重试 3 帧
    let tries = 0;
    let raf = 0;
    const restore = () => {
      el.scrollTop = saved;
      if (Math.abs(el.scrollTop - saved) > 4 && tries++ < 3) raf = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换页时执行；同页改查询参数不回顶
  }, [pathname]);

  // 还没有任何图库文件夹 → 首次使用引导。必须放在所有 hook 之后（hook 数量不能随数据变化）
  if (settings && settings.libraryRoots.length === 0) return <Navigate to="/welcome" replace />;

  return (
    <ScrollContainerContext.Provider value={scrollRef}>
      <div className="flex h-full bg-canvas">
        <Sidebar />
        <main className="min-w-0 flex-1 py-2 pr-2">
          <div
            ref={scrollRef}
            className="relative h-full overflow-x-hidden overflow-y-auto rounded-[var(--radius-sheet)] bg-sheet paper chapter-scope shadow-[var(--shadow-sheet)] scrollbar-thin"
          >
            <Outlet />
          </div>
        </main>
      </div>
      <Lightbox />
      <CommandPalette />
      <HelpDialog />
    </ScrollContainerContext.Provider>
  );
}
