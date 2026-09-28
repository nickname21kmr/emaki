import type { ID, Job } from '@emaki/shared';
import { useMemo } from 'react';
import { useLiveJobs } from '@/lib/events';
import { useJobs, useStartJob } from '@/lib/queries';

/**
 * 「运行识别」：当前的 tag 任务（SSE 推送的实时状态优先，接口列表兜底）+ 启动它的 mutation。
 */
export function useTagJob() {
  const live = useLiveJobs((s) => s.jobs);
  const { data: jobs } = useJobs();

  const job = useMemo<Job | null>(() => {
    const merged = new Map<ID, Job>();
    for (const j of jobs ?? []) merged.set(j.id, j);
    for (const j of Object.values(live)) merged.set(j.id, j);
    return [...merged.values()].find((j) => j.kind === 'tag' && (j.status === 'running' || j.status === 'queued')) ?? null;
  }, [jobs, live]);

  const start = useStartJob(() => '已开始识别，新结果会自动出现在队列里');

  const progress = job?.total ? job.progress / job.total : null;
  return { job, progress, running: !!job || start.isPending, start: () => start.mutate('tag') };
}
