import { ApiRequestError } from './lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ThemeSync } from '@/components/layout/ThemeSync';
import { TooltipProvider } from '@/components/ui';
import { router } from './router';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 本地后端，数据变化靠 SSE 通知，不需要频繁轮询
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // 后端重启（十几秒）期间连不上：读取类请求多重试几次（1、2、4、8、10、10 秒），其他错误只重试一次
      retry: (count, err) => (err instanceof ApiRequestError && err.code === 'network' ? count < 6 : count < 1),
      retryDelay: (count) => Math.min(1000 * 2 ** count, 10_000),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 系统开了「减少动态效果」时，motion 的 JS 动画也直接显示终态（CSS 那边由 index.css 的媒体查询兜底） */}
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ThemeSync />
          <RouterProvider router={router} />
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
                error: '!bg-danger !text-white',
              },
            }}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
