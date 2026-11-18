import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useCapabilities } from '@/lib/capabilities';
import { PAGES, type PageId } from '@/pages';
import { NoAccessPage } from './NoAccessPage';

/**
 * 路由的门（router.tsx 给每个页面套一层）：按 src/pages.ts 声明的能力决定显示页面还是说明页。
 * 还不知道是谁（GET /api/me 没回来）时先不渲染：局域网入口上不会先闪一下没权限的页面；本机入口上只等几毫秒。
 * 首次使用引导在 AppShell 之外（没有页头和滚动容器），没权限时回首页。
 */
export function PageGate({ page, children }: { page: PageId; children: ReactNode }) {
  const { ready, can } = useCapabilities();
  const need = PAGES[page].need;
  if (!ready) return null;
  if (need === null || can(need)) return <>{children}</>;
  if (page === 'welcome') return <Navigate to="/" replace />;
  return <NoAccessPage page={page} need={need} />;
}
