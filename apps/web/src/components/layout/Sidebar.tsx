import type { Job } from '@emaki/shared';
import { Ban, BookCopy, LibraryBig, CircleHelp, Copy, House, Images, Settings, Sparkles, UsersRound, type LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { NavLink } from 'react-router';
import { cn } from '@/lib/cn';
import { useLiveJobs, useRunningJobs } from '@/lib/events';
import { formatCompact, formatCount } from '@/lib/format';
import { annexTotal } from '@/lib/kinds';
import { useHealth, useStats } from '@/lib/queries';
import { Badge, RollingNumber, Tooltip } from '@/components/ui';
import { Emblem } from '@/components/ui/Emblem';

interface NavItem {
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
 * 左侧窄导航栏：图标 + 两个字的标签，和截图一致。
 * 当前项：图标底座变成纸色卡片 + 左侧一道朱色竖线（像书签）。
 */
export function Sidebar() {
  const { data: stats } = useStats();
  const jobs = useRunningJobs();
  const demo = useHealth().data?.dataSource === 'mock';

  const main: NavItem[] = [
    {
      to: '/',
      label: '首页',
      icon: House,
      dot: !!stats?.addedLast7Days[6],
      hint: stats?.addedLast7Days[6] ? `今天新收 ${formatCount(stats.addedLast7Days[6])} 张` : undefined,
    },
    { to: '/gallery', label: '图库', icon: Images },
    { to: '/characters', label: '角色', icon: UsersRound },
    // 原创（用户 2026-09-29）：直达「原创」作品页；还没有原创作品时不显示
    ...(stats?.originalWorkId
      ? [
          {
            to: `/works/${stats.originalWorkId}`,
            label: '原创',
            icon: Sparkles,
            hint: stats.originalCount ? `你归为原创的 ${formatCount(stats.originalCount)} 张，和原创角色的图` : '原创角色的图',
          },
        ]
      : []),
    // 合集（T38d）：本子与画集，不显示数量
    { to: '/collections', label: '合集', icon: LibraryBig },
    // 别册：截图、漫画等不打扰插画的图（T32b），只显示总数
    { to: '/annex', label: '别册', icon: BookCopy, count: annexTotal(stats?.kindCounts) },
  ];
  const triage: NavItem[] = [
    {
      to: '/unrecognized',
      label: '未识别',
      icon: CircleHelp,
      // 待识别的不算（识别跑完会自动处理）；成册待整理的按本算
      count: stats ? stats.unrecognizedCount - stats.untaggedCount + stats.pendingCollectionCount : undefined,
      hint: stats
        ? [
            `${formatCount(stats.unrecognizedCount - stats.untaggedCount)} 张等你确认`,
            stats.pendingCollectionCount ? `${formatCount(stats.pendingCollectionCount)} 本待整理` : '',
            stats.untaggedCount ? `另有 ${formatCount(stats.untaggedCount)} 张等待识别` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : undefined,
    },
    { to: '/duplicates', label: '重复', icon: Copy, count: stats?.duplicateGroupCount, hint: stats?.duplicateGroupCount ? `${formatCount(stats.duplicateGroupCount)} 组重复等你处理` : undefined },
    { to: '/excluded', label: '已排除', icon: Ban },
  ];

  return (
    <aside className="flex w-[76px] shrink-0 flex-col items-center py-4">
      <Logo />

      <nav className="mt-6 flex flex-col items-center gap-1">
        {main.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </nav>

      <div className="my-4 h-px w-8 bg-line-strong" />

      <nav className="flex flex-col items-center gap-1">
        {triage.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </nav>

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
        <JobRing key={job.id} kind={job.kind} progress={job.total ? job.progress / job.total : null} label={job.message} />
      ))}

      <SidebarLink item={{ to: '/settings', label: '设置', icon: Settings }} />
    </aside>
  );
}

function Logo() {
  return (
    <NavLink to="/" className="group flex flex-col items-center gap-1" aria-label="Emaki 首页">
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
const sidebarCount = (n: number) => (n < 100_000 ? formatCount(n) : formatCompact(n));

function SidebarLinkInner({ item, ...rest }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      {...rest}
      to={item.to}
      end={item.to === '/'}
      className="group relative flex w-[64px] flex-col items-center gap-0.5 py-1.5"
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

const JOB_GLYPH: Record<Job['kind'], string> = { scan: '扫', thumbnail: '图', tag: '识', dedupe: '重', 'danbooru-sync': '同' };

/** 后台任务进度环（TR-7）：环里是任务类型字，下面是百分比；点一下去设置页的后台任务 */
function JobRing({ kind, progress, label }: { kind: Job['kind']; progress: number | null; label: string }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  // 识别胶卷的心跳（SEL-19）：每收到一条 job-item，环的线宽 2.5 → 3.2 → 2.5
  const beat = useLiveJobs((s) => (kind === 'tag' ? s.beat : 0));
  const reduce = useReducedMotion();
  return (
    <Tooltip content={label} side="right">
      <NavLink to="/settings#jobs" className="group mb-2 flex w-[64px] flex-col items-center gap-0.5 py-1">
        <span className="relative flex size-9 items-center justify-center">
        <span className="absolute inset-0 flex items-center justify-center font-display text-[11px] leading-none text-fg-muted">
          {JOB_GLYPH[kind]}
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
      </NavLink>
    </Tooltip>
  );
}
