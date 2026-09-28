import type { Job } from '@emaki/shared';
import { ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui';
import { useRunningJob } from '@/lib/events';
import { useStartJob } from '@/lib/queries';

/** 正在跑的查重任务（SSE 推送），没有则为 null */
export function useDedupeJob(): Job | null {
  return useRunningJob('dedupe');
}

/** 「重新查找」：启动 dedupe 任务，运行中显示进度百分比 */
export function RescanButton({ variant = 'secondary' }: { variant?: 'secondary' | 'primary' }) {
  const job = useDedupeJob();
  const start = useStartJob(() => '开始查找重复图片');
  const pct = job?.total ? Math.round((job.progress / job.total) * 100) : null;

  return (
    <Button
      variant={variant}
      icon={<ScanSearch className="size-4" />}
      loading={start.isPending || !!job}
      onClick={() => start.mutate('dedupe')}
    >
      {job ? (pct !== null ? `查找中 ${pct}%` : '查找中…') : '重新查找'}
    </Button>
  );
}
