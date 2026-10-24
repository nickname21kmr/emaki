import type { JobKind } from '@emaki/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLiveJobs } from '@/lib/events';

/**
 * 点过启动按钮之后等这类任务结束，把 job.message 弹出来。
 * 启动前调一次 arm()。几秒就结束的任务（「没有需要识别的图片」）以前看起来像没反应。
 */
export function useJobResultToast(kind: JobKind) {
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  const finished = useLiveJobs((st) =>
    clickedAt === null
      ? null
      : (Object.values(st.jobs).find(
          (j) => j.kind === kind && j.status !== 'running' && j.status !== 'queued' && j.finishedAt && Date.parse(j.finishedAt) >= clickedAt - 2000,
        ) ?? null),
  );
  useEffect(() => {
    if (!finished) return;
    setClickedAt(null);
    if (finished.status === 'failed') toast.error(finished.message);
    else if (finished.status === 'done' && finished.message) toast(finished.message);
  }, [finished]);
  return () => setClickedAt(Date.now());
}
