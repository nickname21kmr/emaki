import { builtinPluginsState, JOB_KINDS, type Job, type LibrarySummary, type NavEntry, type NavIcon, type NavSection } from '@emaki/shared';
import {
  Ban,
  BookCopy,
  Bookmark,
  ChartColumn,
  CircleHelp,
  Clock,
  Compass,
  Copy,
  Download,
  Folder,
  Heart,
  House,
  Images,
  LibraryBig,
  ListOrdered,
  Puzzle,
  Settings,
  Sparkles,
  Star,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { Link, matchPath, NavLink, useLocation, useNavigate } from 'react-router';
import { useCapabilities } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { useLiveJobs, useRunningJobs } from '@/lib/events';
import { formatCompact, formatCount } from '@/lib/format';
import { useHealth, useSummary } from '@/lib/queries';
import { Badge, ContextMenu, ContextMenuItem, RollingNumber, Tooltip } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';
import { usePlugins } from '@/lib/plugins';
import { useCanVisit, useShowsEntry } from '@/pages';

export interface NavItem {
  /** 导航项的 id（插件的 nav.item）；「更多」这种临时的没有 */
  id?: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** 图标上方显示的数量（精确数字，TR-4） */
  count?: number;
  /** 图标右上角的朱色小圆点（TR-8：不再写死「1」） */
  dot?: boolean;
  /** 悬停说明 */
  hint?: string;
  /** 只是捷径（「原创」）：不放进手机底部标签栏的常驻位 */
  shortcut?: boolean;
}

const ICONS: Record<NavIcon, LucideIcon> = {
  house: House,
  images: Images,
  users: UsersRound,
  sparkles: Sparkles,
  library: LibraryBig,
  'book-copy': BookCopy,
  'circle-help': CircleHelp,
  copy: Copy,
  ban: Ban,
  settings: Settings,
  puzzle: Puzzle,
  clock: Clock,
  star: Star,
  bookmark: Bookmark,
  folder: Folder,
  chart: ChartColumn,
  compass: Compass,
  download: Download,
  heart: Heart,
};

/** 导航项的图标（侧栏、底部标签栏、命令面板同一套） */
export const navIcon = (icon: NavIcon): LucideIcon => ICONS[icon] ?? Puzzle;

/**
 * 当前是哪一项（返回它的 to）：地址对得上的里面，带的筛选参数都对得上、参数最多的那个。
 * 插件能加指向同一页、带筛选参数的项（「随便看看」→ /gallery?sort=random），这时只亮它，不和「图库」一起亮；
 * 只有内置项时和 NavLink 的判断一样（首页只认 /，别的认前缀）。
 */
export function activeNav(items: readonly { to: string }[], pathname: string, search: string): string | null {
  const here = new URLSearchParams(search);
  let best: { to: string; score: number } | null = null;
  for (const it of items) {
    const [path = '', query = ''] = it.to.split('?');
    if (!matchPath({ path, end: path === '/' }, pathname)) continue;
    const want = [...new URLSearchParams(query)];
    if (!want.every(([k, v]) => here.get(k) === v)) continue;
    if (!best || want.length > best.score) best = { to: it.to, score: want.length };
  }
  return best?.to ?? null;
}

/**
 * 侧栏的导航项（纯函数，测试直接调）：顺序、名字、在不在侧栏来自插件（docs/plugins.md 9.6，lib/plugins.ts 的 useNav），
 * 这里只给每一项加上图库的情况（计数、朱点、说明、原创的地址）。每项的 to 对应 src/pages.ts 里的一页，
 * 需要的能力由那一页声明，没权限、插件停用的由调用方按 showsEntry 过滤（docs/mobile.md 4.4）。
 * 计数都读汇总接口：服务端按命名口径算好，这里不加减（附录 #28）
 */
export function sidebarItems(
  s: LibrarySummary | undefined,
  nav: Record<NavSection, NavEntry[]> = builtinPluginsState().nav,
): { main: NavItem[]; triage: NavItem[]; footer: NavItem[] } {
  const item = (n: NavEntry): NavItem | null => {
    const base: NavItem = { id: n.id, to: n.to, label: n.label, icon: ICONS[n.icon], shortcut: n.shortcut };
    switch (n.id) {
      case 'home':
        return { ...base, dot: !!s?.added.today, hint: s?.added.today ? `今天新收 ${formatCount(s.added.today)} 张` : undefined };
      // 原创（用户 2026-09-29）：直达「原创」作品页；还没有原创作品时不显示
      case 'original':
        return s?.originalWorkId
          ? {
              ...base,
              to: n.to.replace(':originalWorkId', String(s.originalWorkId)),
              hint: s.images.original ? `你归为原创的 ${formatCount(s.images.original)} 张，和原创角色的图` : '原创角色的图',
            }
          : null;
      // 别册：截图、漫画等不打扰插画的图（T32b），只显示总数
      case 'annex':
        return { ...base, count: s?.images.annex ?? 0 };
      case 'unrecognized':
        return {
          ...base,
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
        };
      case 'duplicates':
        return { ...base, count: s?.duplicates, hint: s?.duplicates ? `${formatCount(s.duplicates)} 组重复等你处理` : undefined };
      default:
        return base;
    }
  };
  const list = (entries: NavEntry[]) => entries.filter((n) => n.visible).flatMap((n) => item(n) ?? []);
  return { main: list(nav.main), triage: list(nav.triage), footer: list(nav.footer) };
}

/** 底部标签栏常驻几页（其余进「更多」） */
const TAB_COUNT = 4;

/**
 * 底部标签栏的项（纯函数）：按侧栏的顺序，前四个（「原创」这种捷径不算）常驻，其余进「更多」，
 * 顺序、计数、说明和侧栏完全一样（都来自 sidebarItems）。能力过滤由调用方做，和侧栏同一个 showsEntry。
 * 默认是首页、图库、角色、合集常驻，其余（原创、别册、未识别、重复、已排除、设置）进「更多」。
 * moreAlert：「更多」里有待处理的（未识别、重复有数，或者带朱点的项）时，「更多」标签上也点一个朱点。
 */
export function tabBarItems(
  s: LibrarySummary | undefined,
  nav?: Record<NavSection, NavEntry[]>,
  showsEntry: (to: string) => boolean = () => true,
): { tabs: NavItem[]; more: NavItem[] } {
  const { main, triage, footer } = sidebarItems(s, nav);
  const all = [...main, ...triage, ...footer].filter((i) => showsEntry(i.to));
  const tabs = all.filter((i) => !i.shortcut).slice(0, TAB_COUNT);
  const more = all.filter((i) => !tabs.includes(i));
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
  const { ready, can } = useCapabilities();
  const plugins = usePlugins();
  const navigate = useNavigate();
  const canVisit = useCanVisit();
  const showsEntry = useShowsEntry();
  const items = sidebarItems(s, plugins.state.nav);
  // 等 GET /api/me 和插件都回来再画：局域网入口上不先闪出没权限的项，改过顺序的不先闪出默认顺序
  const visible = (list: NavItem[]) => (ready && plugins.ready ? list.filter((item) => showsEntry(item.to)) : []);
  const main = visible(items.main);
  const triage = visible(items.triage);
  const footer = visible(items.footer);
  const { pathname, search } = useLocation();
  const current = activeNav([...main, ...triage, ...footer], pathname, search);

  return (
    // 窗口矮（768 的笔记本、计数和任务环都在）时侧栏自己滚，不把整个页面撑高
    // 触屏而且矮（平板横屏 720 高，touch-low）：不放徽记、间距收紧，十项导航一屏放得下（2026-11-19 平板实测最后一项被截掉）
    // 手机横屏（高度 compact）：同样不放徽记，上下留白收紧；左边让出刘海（safe-area）
    // 右键（触屏上长按）：调整页面顺序（docs/plugins.md 9.6）；改顺序要 plugins，没有的设备不弹这个菜单
    <ContextMenu
      disabled={!can('plugins')}
      content={
        <ContextMenuItem icon={<ListOrdered />} onSelect={() => navigate('/plugins?view=pages')}>
          调整页面顺序…
        </ContextMenuItem>
      }
    >
      <aside className="flex w-[76px] shrink-0 flex-col items-center overflow-x-hidden overflow-y-auto py-4 scrollbar-none compact:hidden touch-low:py-2 short:box-content short:py-2 short:pl-[env(safe-area-inset-left)]">
        <Logo />

        <nav className="mt-6 flex flex-col items-center gap-1 touch-low:mt-0 touch-low:gap-0 short:mt-0">
          {main.map((item) => (
            <SidebarLink key={item.id ?? item.to} item={item} active={item.to === current} />
          ))}
        </nav>

        {triage.length > 0 && (
          <>
            <div className="my-4 h-px w-8 shrink-0 bg-line-strong touch-low:my-2 short:my-2" />
            <nav className="flex flex-col items-center gap-1 touch-low:gap-0">
              {triage.map((item) => (
                <SidebarLink key={item.id ?? item.to} item={item} active={item.to === current} />
              ))}
            </nav>
          </>
        )}

        <div className="flex-1" />

        {demo && (
          <Tooltip content="正在使用演示数据（npm run dev:demo），改动不会保存" side="right">
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
          <SidebarLink key={item.id ?? item.to} item={item} active={item.to === current} />
        ))}
      </aside>
    </ContextMenu>
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

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const link = <SidebarLinkInner item={item} active={active} />;
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

function SidebarLinkInner({ item, active: isActive, ...rest }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      {...rest}
      to={item.to}
      aria-current={isActive ? 'page' : undefined}
      className="group relative flex w-[64px] flex-col items-center gap-0.5 py-1.5 touch-low:py-1"
    >
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
    </Link>
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
