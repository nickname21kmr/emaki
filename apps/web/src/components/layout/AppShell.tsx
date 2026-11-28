import { useEffect, useLayoutEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigationType } from 'react-router';
import { Lightbox } from '@/components/media/Lightbox';
import { CommandPalette } from '@/components/overlays/CommandPalette';
import { HelpDialog } from '@/components/overlays/HelpDialog';
import { useServerEvents } from '@/lib/events';
import { useSettings } from '@/lib/queries';
import { useGlobalHotkeys } from './useGlobalHotkeys';
import { ScrollContainerContext } from './ScrollContainer';
import { focusIsNowhere, isScrollKey, shouldFocusPaper } from './scrollFocus';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import { AssistantLauncher, AssistantSpacer } from '@/features/assistant/AssistantLauncher';
import { AccessPrompts } from '@/features/access/AccessPrompts';
import { useCapabilities } from '@/lib/capabilities';
import { useCanVisit } from '@/pages';

/**
 * 整体布局：暖灰「桌面」上左边一条窄导航，右边一张圆角「纸」（主内容，独立滚动）。
 * 助手附页并排时贴在纸的右边，纸让出位置（AssistantSpacer）。
 * 宽度 compact（手机竖屏，A1）：纸铺满屏幕，侧栏换成底部标签栏（TabBar）；手机横屏（高度 compact）照旧是侧栏，让出刘海。
 */
export function AppShell() {
  useServerEvents();
  useGlobalHotkeys();
  const scrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const { pathname, key } = useLocation();
  const navType = useNavigationType();
  const settings = useSettings().data;
  // 首次使用引导要能加文件夹（settings）：手机上空库也留在首页
  const canVisit = useCanVisit();
  const { ready } = useCapabilities();
  const canWelcome = ready && canVisit('/welcome');

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
    // 焦点哪也不在、或者还留在侧栏 / 标签栏上：放到纸上，进了页面直接能用 PageDown / 空格 / Home / End 滚，Tab 也从内容开始
    if (shellRef.current && shouldFocusPaper(document.activeElement, document.body, shellRef.current, el)) el.focus({ preventScroll: true });
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

  // 换页之外焦点也会落回 body（对话框、看图器关掉时原来的元素已经不在了；点的东西随后被卸载了）：按滚动键时先把焦点放到纸上。
  // 不拦按键：浏览器在按键事件派发完之后才按当前焦点找滚动目标，滚动照旧由它来做（按住连滚、平滑滚动都是原生的）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current;
      if (!el || !isScrollKey(e) || !focusIsNowhere(document.activeElement, document.body)) return;
      // 开着对话框、看图器、菜单时按键是它们的（助手附页不算，它不占页面的按键）
      if (document.querySelector('[role="dialog"]:not([data-assistant-sheet]),[role="alertdialog"],[role="menu"]')) return;
      el.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // 还没有任何图库文件夹 → 首次使用引导。必须放在所有 hook 之后（hook 数量不能随数据变化）
  if (settings && settings.libraryRoots.length === 0 && canWelcome) return <Navigate to="/welcome" replace />;

  return (
    <ScrollContainerContext.Provider value={scrollRef}>
      {/* 文档本身永远不滚：只有侧栏和纸各自滚 */}
      <div ref={shellRef} className="flex h-full overflow-hidden bg-canvas compact:flex-col compact:pt-[env(safe-area-inset-top)]">
        <Sidebar />
        <main className="min-w-0 flex-1 py-2 pr-2 compact:min-h-0 compact:p-0 short:pr-[max(0.5rem,env(safe-area-inset-right))]">
          <div
            ref={scrollRef}
            // 能接焦点（不进 Tab 顺序）：键盘滚动要焦点在滚动容器上。outline-none：聚焦时不画焦点框（index.css 的 :focus-visible 会给整张纸描一圈朱线）
            tabIndex={-1}
            className="relative h-full overflow-x-hidden overflow-y-auto rounded-[var(--radius-sheet)] bg-sheet paper chapter-scope shadow-[var(--shadow-sheet)] outline-none scrollbar-thin compact:rounded-none compact:shadow-none"
          >
            <Outlet />
          </div>
        </main>
        {/* 并排时占 W + 8：纸的右边缘到附页左边缘正好 8px 桌面；宽度一帧到位不补间 */}
        <AssistantSpacer />
        <TabBar />
      </div>
      <Lightbox />
      <CommandPalette />
      <HelpDialog />
      <AssistantLauncher />
      {/* 手机发来连接请求时，任何页面都弹出批准提示 */}
      <AccessPrompts />
    </ScrollContainerContext.Provider>
  );
}
