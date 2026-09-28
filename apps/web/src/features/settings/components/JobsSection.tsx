import type { Job } from '@emaki/shared';
import { ChevronDown, Play, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  Progress,
  Skeleton,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { useCancelJob, useMergedJobs, useNow, useStartJob } from '../hooks';
import {
  estimateRemaining,
  formatDuration,
  isActiveJob,
  JOB_ICON,
  JOB_KINDS,
  JOB_LABEL,
  JOB_STATUS,
  jobFraction,
} from '../jobMeta';
import { SettingsCard, SettingsSection } from './SettingsSection';
import { EASE_OUT } from '@/lib/motion';

const COLLAPSED = 6;

export function JobsSection() {
  const { jobs, isPending, error, refetch } = useMergedJobs();
  const start = useStartJob();
  const [expanded, setExpanded] = useState(false);
  const running = jobs.some((j) => j.status === 'running');
  // 有任务在跑时每秒刷新一次，剩余时间和「开始于」才会走
  const now = useNow(running);
  const activeKinds = new Set(jobs.filter(isActiveJob).map((j) => j.kind));
  const visible = expanded ? jobs : jobs.slice(0, COLLAPSED);

  return (
    <SettingsSection
      id="jobs"
      description="扫描、识别、查重在后台依次运行，离开这个页面也不会中断。"
      actions={
        <Menu
          width={200}
          trigger={
            <Button variant="ghost" icon={<Play />}>
              运行任务
            </Button>
          }
        >
          <MenuLabel>手动运行</MenuLabel>
          {JOB_KINDS.map((kind) => {
            const Icon = JOB_ICON[kind];
            return (
              <MenuItem
                key={kind}
                icon={<Icon />}
                disabled={activeKinds.has(kind)}
                onSelect={() => start.mutate(kind)}
              >
                {JOB_LABEL[kind]}
              </MenuItem>
            );
          })}
        </Menu>
      }
    >
      <SettingsCard>
        {isPending ? (
          <JobsSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : jobs.length === 0 ? (
          <EmptyState
            glyph="闲"
            title="现在很清闲"
            description="扫描、识别、查重开始后，进度会显示在这里。"
            className="py-12"
          />
        ) : (
          <>
            <ul className="relative divide-y divide-line">
              <AnimatePresence initial={false}>
                {visible.map((job) => (
                  <JobRow key={job.id} job={job} now={now} />
                ))}
              </AnimatePresence>
            </ul>
            {jobs.length > COLLAPSED && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center justify-center gap-1 py-3 text-[13px] text-fg-muted transition-colors hover:text-fg"
              >
                {expanded ? '收起' : `显示更早的 ${jobs.length - COLLAPSED} 条`}
                <ChevronDown className={cn('size-3.5 transition-transform duration-200', expanded && 'rotate-180')} />
              </button>
            )}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const cancel = useCancelJob();
  const Icon = JOB_ICON[job.kind];
  const status = JOB_STATUS[job.status];
  const active = isActiveJob(job);
  const running = job.status === 'running';
  const fraction = jobFraction(job);

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="flex items-center gap-4 py-4"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-300 [&_svg]:size-[18px]',
          running ? 'bg-shu-soft text-shu-fg' : 'bg-sunken text-fg-muted',
        )}
      >
        <Icon />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{JOB_LABEL[job.kind]}</span>
          <Badge tone={status.tone} dot={running}>
            {status.label}
          </Badge>
        </div>
        <div className={cn('mt-1 truncate text-xs tabular', job.status === 'failed' ? 'text-danger' : 'text-fg-muted')}>
          <JobMeta job={job} now={now} />
        </div>
        {active && (
          <Progress className="mt-2.5" value={job.status === 'queued' ? null : fraction} tone="shu" />
        )}
      </div>

      {running && fraction !== null ? (
        <span className="numeral w-16 shrink-0 text-right text-[30px] tabular">
          {Math.floor(fraction * 100)}
          <span className="ml-0.5 text-base text-fg-muted">%</span>
        </span>
      ) : (
        !active &&
        job.startedAt && (
          <span className="shrink-0 text-xs text-fg-subtle tabular" title="开始时间">
            {formatDateTime(job.startedAt)}
          </span>
        )
      )}

      {active && (
        <IconButton label="取消任务" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
          <X />
        </IconButton>
      )}
    </motion.li>
  );
}

/** 第二行的说明：每种状态关心的信息不一样 */
function JobMeta({ job, now }: { job: Job; now: number }) {
  const count = job.total ? `${formatCount(job.progress)} / ${formatCount(job.total)}` : formatCount(job.progress);
  switch (job.status) {
    case 'queued':
      return <>等前面的任务完成后开始</>;
    case 'running': {
      const remaining = estimateRemaining(job, now);
      return (
        <>
          {count}
          {remaining !== null && ` · 还需约 ${formatDuration(remaining)}`}
          {job.startedAt && ` · 开始于 ${formatRelative(job.startedAt, now)}`}
        </>
      );
    }
    case 'done':
      return (
        <>
          {job.total ? `处理了 ${formatCount(job.total)} 项` : '已完成'}
          {job.startedAt && job.finishedAt && ` · 用时 ${formatDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`}
          {job.finishedAt && ` · ${formatRelative(job.finishedAt)}`}
        </>
      );
    case 'failed':
      return <>{job.message || '任务失败'}</>;
    case 'cancelled':
      return (
        <>
          {job.startedAt ? `在 ${count} 时取消` : '开始前就取消了'}
          {job.finishedAt && ` · ${formatRelative(job.finishedAt)}`}
        </>
      );
  }
}

function JobsSkeleton() {
  return (
    <div className="divide-y divide-line">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 py-4">
          <Skeleton className="size-10 rounded-[10px]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-52" />
          </div>
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
