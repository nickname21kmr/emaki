import type { ID } from '@emaki/shared';
import { AnimatePresence, motion } from 'motion/react';
import { JobFilmstrip } from '@/components/media/JobFilmstrip';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useRunningJob } from '@/lib/events';
import { formatCount, formatPercent } from '@/lib/format';
import { useMutate } from '@/lib/queries';
import { EASE_OUT_SOFT, JOB_LABEL } from '../utils';

/**
 * 后台任务横幅：贴在纸的最上沿，一行字 + 底边一道朱色细进度线。
 * 任务结束时收起。
 */
export function JobBanner() {
  const job = useRunningJob();
  // cancelJob 只返回 { ok }，补成 MutationResult 好让 useMutate 统一出 toast
  const cancel = useMutate((id: ID) =>
    api.cancelJob(id).then(() => ({ ok: true as const, message: '已取消后台任务', undoToken: null })),
  );

  const fraction = job?.total ? job.progress / job.total : null;
  // 数字只出现一次：消息开头的「123 / 1800 ·」去掉；设备编号这种技术细节也去掉
  const detail = job
    ? (job.total != null ? job.message.replace(/^\s*[\d,]+\s*\/\s*[\d,]+\s*(·\s*)?/, '') : job.message).replace(/GPU·[^·\s]+/, 'GPU')
    : '';

  return (
    <AnimatePresence initial={false}>
      {job && (
        <motion.div
          key="job-banner"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.4, ease: EASE_OUT_SOFT }}
          className="overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <div className="relative flex h-10 items-center gap-3 border-b border-line bg-sheet px-8 text-[13px]">
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inset-0 animate-ping rounded-full bg-shu opacity-50" />
              <span className="relative size-2 rounded-full bg-shu" />
            </span>
            <span className="shrink-0 font-medium">{JOB_LABEL[job.kind]}</span>
            {detail && <span className="min-w-0 truncate text-fg-subtle">{detail}</span>}
            {job.kind === 'tag' && <JobFilmstrip jobId={job.id} className="ml-auto shrink-0" />}

            <span className={cn('shrink-0 text-fg-subtle tabular', job.kind !== 'tag' && 'ml-auto')}>
              {job.total ? (
                <>
                  {formatCount(job.progress)} / {formatCount(job.total)}
                  <span className="ml-2 font-semibold text-fg">{formatPercent(fraction ?? 0)}</span>
                </>
              ) : (
                `已处理 ${formatCount(job.progress)}`
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              loading={cancel.isPending}
              onClick={() => cancel.mutate(job.id)}
              className="-mr-2.5 text-fg-subtle hover:text-fg"
            >
              取消
            </Button>

            <ThinProgress value={fraction} glint={job.kind === 'tag'} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 横幅底边的 2px 进度线；总量未知时来回滑动 */
function ThinProgress({ value, glint }: { value: number | null; glint?: boolean }) {
  return (
    <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
      {value === null ? (
        <div className="h-full w-1/3 animate-indeterminate bg-shu" />
      ) : (
        <div
          className={cn('h-full rounded-r-full bg-shu transition-[width] duration-300 ease-out', glint && 'glint')}
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        />
      )}
    </div>
  );
}
