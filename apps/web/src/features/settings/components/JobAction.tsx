import type { Job, JobKind } from '@emaki/shared';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Button, IconButton, Progress, type ButtonProps } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useActiveJob, useCancelJob, useStartJob } from '../hooks';
import { JOB_VERB, jobFraction } from '../jobMeta';
import { EASE_OUT } from '@/lib/motion';

const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18, ease: EASE_OUT },
};

/**
 * 启动某类后台任务的按钮。这类任务在跑时，按钮原地换成迷你进度条 + 取消，
 * 这样「立即扫描」「立即同步」旁边就能看到进度，不用跳去「后台任务」一节。
 */
export function JobAction({
  kind,
  icon,
  children,
  variant = 'secondary',
  disabled,
}: {
  kind: JobKind;
  icon?: ReactNode;
  children: ReactNode;
  variant?: ButtonProps['variant'];
  disabled?: boolean;
}) {
  const job = useActiveJob(kind);
  const start = useStartJob();
  return (
    <AnimatePresence mode="wait" initial={false}>
      {job ? (
        <motion.div key="running" {...swap}>
          <JobProgressInline job={job} />
        </motion.div>
      ) : (
        <motion.div key="idle" {...swap}>
          <Button
            variant={variant}
            icon={icon}
            loading={start.isPending}
            disabled={disabled}
            onClick={() => start.mutate(kind)}
          >
            {children}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function JobProgressInline({ job }: { job: Job }) {
  const cancel = useCancelJob();
  const queued = job.status === 'queued';
  return (
    <div className="flex h-9 items-center gap-2">
      <div className="w-40">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px] leading-none tabular">
          <span className="font-medium text-fg">{queued ? '排队中' : JOB_VERB[job.kind]}</span>
          <span className="truncate text-fg-muted">
            {queued ? '等前面的任务' : job.total ? `${formatCount(job.progress)} / ${formatCount(job.total)}` : '准备中…'}
          </span>
        </div>
        <Progress value={queued ? null : jobFraction(job)} tone="shu" />
      </div>
      <IconButton size="sm" label="取消任务" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
        <X />
      </IconButton>
    </div>
  );
}
