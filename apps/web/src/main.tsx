import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ThemeSync } from '@/components/layout/ThemeSync';
import { TooltipProvider } from '@/components/ui';
import { ConnectionBanner } from '@/features/access/ConnectionBanner';
import { api } from './lib/api';
import { watchForbidden } from './lib/capabilities';
import { watchConnection } from './lib/connection';
import { useDeviceAuth } from './lib/deviceAuth';
import { meRetry, qk } from './lib/queries';
import { createQueryClient } from './lib/queryClient';
import { routes } from './router';
import './styles/index.css';

// 缺省的过期、回收、重试时间都在 lib/queryClient.ts
const queryClient = createQueryClient();

// 谁在调用（lib/capabilities.ts）：一开始就去问，页面等它的时间最短；请求回 403 forbidden 时重新问（权限可能刚在电脑上改了）
void queryClient.prefetchQuery({ queryKey: qk.me, queryFn: api.me, retry: meRetry, retryDelay: 500 });
// 侧栏、首页一挂上就要的三样跟着一起发，不等组件挂上之后的 effect，少一波往返。queryFn 和 lib/queries.ts 里的 hook 是同一个，
// hook 挂上时接着用这次请求，不会再发一遍
void queryClient.prefetchQuery({ queryKey: qk.summary, queryFn: api.summary });
void queryClient.prefetchQuery({ queryKey: qk.settings, queryFn: api.settings });
void queryClient.prefetchQuery({ queryKey: qk.health, queryFn: api.health, staleTime: Infinity });
watchForbidden(queryClient);
// 连不上电脑：浏览器里顶部提示、App 里交给 App；重新连上时全部重新取（lib/connection.ts）
watchConnection(queryClient);

const router = createBrowserRouter(routes);

// 局域网入口上没有凭证时才用到（本机入口不下载它）
const PairingPage = lazy(() => import('./features/access/PairingPage').then((m) => ({ default: m.PairingPage })));

/** 手机浏览器打开局域网入口、还没批准（或被电脑移除了）：任何请求收到这两种 401，整页换成「连接到电脑」（lib/deviceAuth.ts） */
function Root() {
  const lost = useDeviceAuth((s) => s.lost);
  if (lost)
    return (
      <Suspense fallback={null}>
        <PairingPage reason={lost} />
      </Suspense>
    );
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 系统开了「减少动态效果」时，motion 的 JS 动画也直接显示终态（CSS 那边由 index.css 的媒体查询兜底） */}
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeSync />
          <Root />
          <ConnectionBanner />
          <Toaster
            position="bottom-center"
            offset={24}
            visibleToasts={3}
            gap={8}
            toastOptions={{
              classNames: {
                toast:
                  // pointer-events-auto：Radix 弹窗打开时 body 是 pointer-events:none，不加的话 toast 上的「撤销」点不了
                  // 胶囊样式只给 sonner 自带的 toast；自绘的结果 toast（SEL-11）data-styled=false，自己画
                  '!pointer-events-auto data-[styled=true]:!rounded-full data-[styled=true]:!bg-ink data-[styled=true]:!text-fg-inverse data-[styled=true]:!border-0 data-[styled=true]:!shadow-pop data-[styled=true]:!px-5 data-[styled=true]:!py-3 data-[styled=true]:!text-[13px] data-[styled=true]:!font-medium data-[styled=true]:!gap-3',
                actionButton: '!bg-white/15 !text-fg-inverse !rounded-full !px-3 !font-semibold',
                // 撤销确认里的「取消」：比「撤销」淡一档
                cancelButton: '!bg-transparent !text-fg-inverse/70 hover:!text-fg-inverse !rounded-full !px-2',
                description: '!text-fg-inverse/65',
                error: '!bg-danger !text-white',
              },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
