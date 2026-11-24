import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useCapabilities } from '@/lib/capabilities';
import { DisabledPage } from '@/features/plugins/DisabledPage';
import { useDisabledPages, useNav, usePlugins } from '@/lib/plugins';
import { PAGES, useCanVisit, type PageId } from '@/pages';
import { NoAccessPage } from './NoAccessPage';

/**
 * 路由的门（router.tsx 给每个页面套一层）：按 src/pages.ts 声明的能力决定显示页面还是说明页。
 * 还不知道是谁（GET /api/me 没回来）时先不渲染：局域网入口上不会先闪一下没权限的页面；本机入口上只等几毫秒。
 * 首次使用引导在 AppShell 之外（没有页头和滚动容器），没权限时回首页。
 * 页面所属的插件停用了显示「这一页已停用」（docs/plugins.md 9.4）；首页停用了，「/」去侧栏里第一个能去的页面。
 */
export function PageGate({ page, children }: { page: PageId; children: ReactNode }) {
  const { ready, can } = useCapabilities();
  const plugins = usePlugins();
  const disabled = useDisabledPages();
  const need = PAGES[page].need;
  if (!ready) return null;
  if (need !== null && !can(need)) return page === 'welcome' ? <Navigate to="/" replace /> : <NoAccessPage page={page} need={need} />;
  // 停用的插件的页面（docs/plugins.md 9.4）：插件状态回来之前先不画，免得先闪一下页面
  if (!plugins.ready && page !== 'welcome') return null;
  // 不认识的地址显示首页：首页停用了它也一样
  const own = page === 'fallback' ? 'home' : page;
  if (disabled.has(own)) return own === 'home' ? <FirstPage /> : <DisabledPage page={page} />;
  return <>{children}</>;
}

/** 首页停用了：「/」和不认识的地址去侧栏里第一个能去的页面（都去不了时才显示停用页） */
function FirstPage() {
  const nav = useNav();
  const canVisit = useCanVisit();
  const first = Object.values(nav)
    .flat()
    .find((n) => n.visible && !n.to.includes(':') && n.to !== '/' && canVisit(n.to));
  return first ? <Navigate to={first.to} replace /> : <DisabledPage page="home" />;
}
