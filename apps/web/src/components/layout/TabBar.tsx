import { Ellipsis } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { matchPath, NavLink, useLocation } from 'react-router';
import { Badge, RollingNumber, Sheet } from '@/components/ui';
import { useCapabilities } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { useRunningJobs } from '@/lib/events';
import { useHealth, useSummary } from '@/lib/queries';
import { useCanVisit } from '@/pages';
import { usePlugins } from '@/lib/plugins';
import { JobRing, moreAlert, sidebarCount, tabBarItems, type NavItem } from './Sidebar';

/**
 * 底部标签栏（A1）：宽度 compact（手机竖屏）时代替侧栏，其余宽度不显示（CSS 的 compact: 变体）。
 * 按侧栏的顺序前四页常驻（默认首页、图库、角色、合集），「更多」打开底部面板放其余几页；项、计数、说明、能力过滤和侧栏同一套（tabBarItems）。
 * 底下让出手势导航条（safe-area-inset-bottom）。
 */
export function TabBar() {
  const { data: s } = useSummary();
  const { ready } = useCapabilities();
  const canVisit = useCanVisit();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const plugins = usePlugins();
  // 和侧栏一样等 GET /api/me 和插件回来再画；没权限、停用的不显示（先过滤再分常驻和「更多」，前四个总是能去的）
  const items = tabBarItems(s, plugins.state.nav, canVisit);
  const shown = ready && plugins.ready;
  const tabs = shown ? items.tabs : [];
  const more = shown ? items.more : [];
  const inMore = more.some((i) => matchPath({ path: i.to, end: false }, pathname));

  return (
    <nav
      aria-label="主导航"
      className="hidden shrink-0 items-stretch border-t border-line bg-canvas px-1 pb-[env(safe-area-inset-bottom)] compact:flex"
    >
      {tabs.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className="flex min-w-0 flex-1">
          {({ isActive }) => <TabFace item={item} active={isActive} />}
        </NavLink>
      ))}
      {more.length > 0 && (
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="flex min-w-0 flex-1">
          <TabFace item={{ to: '', label: '更多', icon: Ellipsis, dot: moreAlert(more) }} active={inMore || open} />
        </button>
      )}
      <MoreSheet open={open} onOpenChange={setOpen} items={more} />
    </nav>
  );
}

function TabFace({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <span className="relative flex h-14 w-full flex-col items-center justify-center gap-0.5">
      <span className="relative flex h-7 w-12 items-center justify-center">
        {active && (
          <motion.span
            layoutId="tabbar-active"
            className="absolute inset-0 rounded-full bg-sheet shadow-card ring-1 ring-line"
            transition={{ type: 'spring', stiffness: 520, damping: 40 }}
          />
        )}
        <Icon className={cn('relative size-[19px]', active ? 'text-shu' : 'text-fg-muted')} strokeWidth={active ? 2.2 : 1.8} />
        {item.dot && <span className="absolute top-0 right-2.5 size-2 rounded-full bg-shu ring-2 ring-canvas" />}
      </span>
      <span className={cn('text-[11px] leading-none', active ? 'font-semibold text-fg' : 'text-fg-muted')}>{item.label}</span>
    </span>
  );
}

/** 「更多」：其余几页排成三列，计数照侧栏的规则写在名字下面；后台任务的进度环、演示数据的提示也放这里 */
function MoreSheet({ open, onOpenChange, items }: { open: boolean; onOpenChange: (v: boolean) => void; items: NavItem[] }) {
  const jobs = useRunningJobs();
  const demo = useHealth().data?.dataSource === 'demo';
  const canVisit = useCanVisit();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="更多">
      <div className="grid grid-cols-3 gap-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => onOpenChange(false)}
              className={({ isActive }) =>
                cn(
                  'relative flex min-h-[84px] flex-col items-center justify-center gap-1.5 rounded-[14px] px-2 py-3 ring-1 transition-colors',
                  isActive ? 'bg-sheet ring-line-strong' : 'bg-sunken/60 ring-transparent active:bg-hover',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn('size-5', isActive ? 'text-shu' : 'text-fg-muted')} strokeWidth={isActive ? 2.2 : 1.8} />
                    {item.dot && <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-shu ring-2 ring-raised" />}
                  </span>
                  <span className={cn('text-[13px]', isActive ? 'font-semibold text-fg' : 'text-fg')}>{item.label}</span>
                  {item.count !== undefined && item.count > 0 && (
                    <RollingNumber value={item.count} format={sidebarCount} size="xs" className="tabular text-[11px] leading-3 text-fg-muted" />
                  )}
                  {item.hint && <span className="sr-only">{item.hint}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </div>
      {(jobs.length > 0 || demo) && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {jobs.slice(0, 3).map((job) => (
            <div key={job.id} className="flex items-center gap-1" onClick={() => onOpenChange(false)}>
              <JobRing
                kind={job.kind}
                progress={job.total ? job.progress / job.total : null}
                label={job.message}
                to={canVisit('/settings#jobs') ? '/settings#jobs' : null}
              />
              <span className="max-w-[12rem] truncate text-[12px] text-fg-muted">{job.message}</span>
            </div>
          ))}
          {demo && (
            <Badge tone="warn" className="px-1.5 text-[10px]">
              演示数据 · 改动不会保存
            </Badge>
          )}
        </div>
      )}
    </Sheet>
  );
}
