import { JOB_KINDS, type Job, type LibrarySummary } from '@emaki/shared';
import { Ban, BookCopy, LibraryBig, CircleHelp, Copy, House, Images, Settings, Sparkles, UsersRound, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useCapabilities } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { useLiveJobs, useRunningJobs } from '@/lib/events';
import { formatCompact, formatCount } from '@/lib/format';
import { useHealth, useSummary } from '@/lib/queries';
import { Badge, RollingNumber, Tooltip } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';
import { useCanVisit } from '@/pages';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** 图标上方显示的数量（精确数字，TR-4） */
  count?: number;
  /** 图标右上角的朱色小圆点（TR-8：不再写死「1」） */
  dot?: boolean;
  /** 悬停说明 */
  hint?: string;
}

/**
 * 侧栏的导航项（纯函数，测试直接调）：每项的 to 对应 src/pages.ts 里的一页，需要的能力由那一页声明，
 * 没权限的不显示（docs/mobile.md 4.4）。计数都读汇总接口：服务端按命名口径算好，这里不加减（附录 #28）
 */
export function sidebarItems(s: LibrarySummary | undefined): { main: NavItem[]; triage: NavItem[]; footer: NavItem[] } {
  const main: NavItem[] = [
    {
      to: '/',
      label: '首页',
      icon: House,
      dot: !!s?.added.today,
      hint: s?.added.today ? `今天新收 ${formatCount(s.added.today)} 张` : undefined,
    },
    { to: '/gallery', label: '图库', icon: Images },
    { to: '/characters', label: '角色', icon: UsersRound },
    // 原创（用户 2026-09-29）：直达「原创」作品页；还没有原创作品时不显示
    ...(s?.originalWorkId
      ? [
          {
            to: `/works/${s.originalWorkId}`,
            label: '原创',
            icon: Sparkles,
            hint: s.images.original ? `你归为原创的 ${formatCount(s.images.original)} 张，和原创角色的图` : '原创角色的图',
          },
        ]
      : []),
    // 合集（T38d）：本子与画集，不显示数量
    { to: '/collections', label: '合集', icon: LibraryBig },
    // 别册：截图、漫画等不打扰插画的图（T32b），只显示总数
    { to: '/annex', label: '别册', icon: BookCopy, count: s?.images.annex ?? 0 },
  ];
  const triage: NavItem[] = [
    {
      to: '/unrecognized',
      label: '未识别',
      icon: CircleHelp,
      // 待处理数（唯一定义见汇总接口 triage）：等你确认的张数 + 成册待整理的本数；待识别的不算（识别跑完会自动处理）
      count: s?.triage.total,
      hint: s
        ? [
            `${formatCount(s.triage.images)} 张等你确认`,
            s.triage.books ? `${formatCount(s.triage.books)} 本待整理` : '',
            s.triage.waiting ? `另有 ${formatCount(s.triage.waiting)} 张等待识别` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : undefined,
    },
    {
      to: '/duplicates',
      label: '重复',
      icon: Copy,
      count: s?.duplicates,
      hint: s?.duplicates ? `${formatCount(s.duplicates)} 组重复等你处理` : undefined,
    },
    { to: '/excluded', label: '已排除', icon: Ban },
  ];
  const footer: NavItem[] = [{ to: '/settings', label: '设置', icon: Settings }];
  return { main, triage, footer };
}

/** 底部标签栏（宽度 compact，A1）常驻的几页，按这个顺序；其余的进「更多」 */
export const TAB_PATHS = ['/', '/gallery', '/characters', '/collections'] as const;

/**
 * 底部标签栏的项（纯函数）：首页、图库、角色、合集常驻，其余（原创、别册、未识别、重复、已排除、设置）进「更多」，
 * 顺序、计数、说明和侧栏完全一样（都来自 sidebarItems）。能力过滤由调用方做，和侧栏同一个 canVisit。
 * moreAlert：「更多」里有待处理的（未识别、重复有数，或者带朱点的项）时，「更多」标签上也点一个朱点。
 */
export function tabBarItems(s: LibrarySummary | undefined): { tabs: NavItem[]; more: NavItem[] } {
  const { main, triage, footer } = sidebarItems(s);
  const all = [...main, ...triage, ...footer];
  const tabs = TAB_PATHS.flatMap((to) => all.filter((i) => i.to === to));
  const more = all.filter((i) => !(TAB_PATHS as readonly string[]).includes(i.to));
  return { tabs, more };
}

/** 「更多」里有没有待处理的：未识别、重复有数，或者哪一项带了朱点 */
export const moreAlert = (more: NavItem[]): boolean =>
  more.some((i) => i.dot || ((i.to === '/unrecognized' || i.to === '/duplicates') && (i.count ?? 0) > 0));

/**
 * 左侧窄导航栏：图标 + 两个字的标签，和截图一致。宽度 compact（手机竖屏）时换成底部标签栏（TabBar.tsx），这里不显示。
 * 当前项：图标底座变成纸色卡片 + 左侧一道朱色竖线（像书签）。
 * 导航等 GET /api/me 回来再画（局域网入口上不先闪出没权限的项），没权限的项不显示。
 */
export function Sidebar() {
  const { data: s } = useSummary();
  const jobs = useRunningJobs();
  const demo = useHealth().data?.dataSource === 'demo';
  const { ready } = useCapabilities();
  const canVisit = useCanVisit();
  const items = sidebarItems(s);
  const visible = (list: NavItem[]) => (ready ? list.filter((item) => canVisit(item.to)) : []);
  const main = visible(items.main);
  const triage = visible(items.triage);
  const footer = visible(items.footer);

  return (
    // 窗口矮（768 的笔记本、计数和任务环都在）时侧栏自己滚，不把整个页面撑高
    // 触屏而且矮（平板横屏 720 高，touch-low）：不放徽记、间距收紧，十项导航一屏放得下（2026-11-19 平板实测最后一项被截掉）
    // 手机横屏（高度 compact）：同样不放徽记，上下留白收紧；左边让出刘海（safe-area）
    <aside className="flex w-[76px] shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto py-4 scrollbar-none compact:hidden touch-low:py-2 short:box-content short:py-2 short:pl-[env(safe-area-inset-left)]">
      <Logo />

      <nav className="mt-6 flex flex-col items-center gap-1 touch-low:mt-0 touch-low:gap-0 short:mt-0">
        {main.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </nav>

      {triage.length > 0 && (
        <>
          <div className="my-4 h-px w-8 shrink-0 bg-line-strong touch-low:my-2 short:my-2" />
          <nav className="flex flex-col items-center gap-1 touch-low:gap-0">
            {triage.map((item) => (
              <SidebarLink key={item.to} item={item} />
            ))}
          </nav>
        </>
      )}

      <div className="flex-1" />

      {demo && (
        <Tooltip content="正在使用演示数据（npm run dev:mock），改动不会保存" side="right">
          <span className="mb-3">
            <Badge tone="warn" className="px-1.5 text-[10px]">
              演示数据
            </Badge>
          </span>
        </Tooltip>
      )}

      {jobs.slice(0, 2).map((job) => (
        <JobRing
          key={job.id}
          kind={job.kind}
          progress={job.total ? job.progress / job.total : null}
          label={job.message}
          to={canVisit('/settings#jobs') ? '/settings#jobs' : null}
        />
      ))}

      {footer.map((item) => (
        <SidebarLink key={item.to} item={item} />
      ))}
    </aside>
  );
}

function Logo() {
  return (
    <NavLink to="/" className="group flex flex-col items-center gap-1 touch-low:hidden short:hidden" aria-label="Emaki 首页">
      <Emblem size={40} spin />
      <span className="text-[10px] font-semibold tracking-[0.12em] text-fg-muted uppercase">Emaki</span>
    </NavLink>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  const link = <SidebarLinkInner item={item} />;
  return item.hint ? (
    <Tooltip content={item.hint} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/** 10 万以内显示精确数字，再大才缩写（TR-4） */
export const sidebarCount = (n: number) => (n < 100_000 ? formatCount(n) : formatCompact(n));

function SidebarLinkInner({ item, ...rest }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      {...rest}
      to={item.to}
      end={item.to === '/'}
      className="group relative flex w-[64px] flex-col items-center gap-0.5 py-1.5 touch-low:py-1"
    >
      {({ isActive }) => (
        <>
          {item.count !== undefined && item.count > 0 && (
            <RollingNumber
              value={item.count}
              format={sidebarCount}
              size="xs"
              className="tabular -mb-0.5 animate-fade-in text-[10px] leading-3 font-medium text-fg-muted"
            />
          )}
          <span className="relative flex size-9 items-center justify-center">
            {isActive && (
              <motion.span
                layoutId="sidebar-active"
                className="absolute inset-0 rounded-[11px] bg-sheet shadow-card ring-1 ring-line"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              />
            )}
            <Icon
              className={cn(
                'relative size-[19px] transition-colors duration-200',
                isActive ? 'text-shu' : 'text-fg-muted group-hover:text-fg',
              )}
              strokeWidth={isActive ? 2.2 : 1.8}
            />
            {item.dot && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-shu ring-2 ring-canvas" />}
          </span>
          <span
            className={cn(
              'text-[11px] transition-colors duration-200',
              isActive ? 'font-semibold text-fg' : 'text-fg-muted group-hover:text-fg',
            )}
          >
            {item.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

/** 后台任务进度环（TR-7）：环里是任务类型字，下面是百分比；点一下去设置页的后台任务（去不了设置页时只显示进度） */
export function JobRing({ kind, progress, label, to }: { kind: Job['kind']; progress: number | null; label: string; to: string | null }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  // 识别胶卷的心跳（SEL-19）：每收到一条 job-item，环的线宽 2.5 → 3.2 → 2.5
  const beat = useLiveJobs((s) => (kind === 'tag' ? s.beat : 0));
  const reduce = useReducedMotion();
  return (
    <Tooltip content={label} side="right">
      <MaybeLink to={to} className="group mb-2 flex w-[64px] flex-col items-center gap-0.5 py-1">
        <span className="relative flex size-9 items-center justify-center">
        <span className="absolute inset-0 flex items-center justify-center font-display text-[11px] leading-none text-fg-muted">
          {JOB_KINDS[kind].glyph}
        </span>
        <svg viewBox="0 0 32 32" className={cn('size-8 -rotate-90', progress === null && 'animate-spin')}>
          <circle cx="16" cy="16" r={r} fill="none" stroke="var(--c-line-strong)" strokeWidth="2.5" />
          <motion.circle
            key={beat}
            cx="16"
            cy="16"
            r={r}
            fill="none"
            stroke="var(--c-shu)"
            initial={{ strokeWidth: 2.5 }}
            animate={beat && !reduce ? { strokeWidth: [2.5, 3.2, 2.5] } : { strokeWidth: 2.5 }}
            transition={{ duration: 0.3 }}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - (progress ?? 0.25))}
            className="transition-[stroke-dashoffset] duration-300"
          />
        </svg>
        </span>
        <span className="text-[11px] text-fg-muted tabular group-hover:text-fg">{progress !== null ? `${Math.round(progress * 100)}%` : '进行中'}</span>
      </MaybeLink>
    </Tooltip>
  );
}

/** 有地址时是链接，没有时只是一块（Tooltip 要一个能拿到 ref 的子元素） */
function MaybeLink({ to, className, children }: { to: string | null; className: string; children: ReactNode }) {
  if (to)
    return (
      <NavLink to={to} className={className}>
        {children}
      </NavLink>
    );
  return (
    <span tabIndex={0} className={className}>
      {children}
    </span>
  );
}
