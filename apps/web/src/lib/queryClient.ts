import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from './api';
import { EVENT_FRESH_ROOTS, EVENT_FRESH_STALE_MS } from './events';

/** 整个应用共用的那个 QueryClient（main.tsx 建一次）。缺省值集中在这里，queryClient.test.ts 对着核对 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // 本地后端，数据变化靠 SSE 通知，不需要频繁轮询
        staleTime: 30_000,
        // 没人用的查询留 30 分钟再回收（库的缺省是 5 分钟）：看了几分钟别的再后退，图库翻过的那些页还在，能回到原来的位置
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        // 后端重启（十几秒）期间连不上：读取类请求多重试几次（1、2、4、8、10、10 秒），其他错误只重试一次
        retry: (count, err) => (err instanceof ApiRequestError && err.code === 'network' ? count < 6 : count < 1),
        retryDelay: (count) => Math.min(1000 * 2 ** count, 10_000),
      },
    },
  });
  // 图片、角色、作品、合集这些重列表（lib/events.ts 的 EVENT_FRESH_ROOTS）：变化都有 changed 事件来标记过期，标记过的不看 staleTime，
  // 所以放长到 10 分钟。不然离开半分钟再后退，无限列表会把已加载的每一页在后台白拉一遍。
  // hook 自己写了 staleTime 的照它自己的；其余的查询（汇总、统计、搜索、设置、助手……）保持上面的 30 秒
  for (const root of EVENT_FRESH_ROOTS) client.setQueryDefaults([root], { staleTime: EVENT_FRESH_STALE_MS });
  return client;
}
