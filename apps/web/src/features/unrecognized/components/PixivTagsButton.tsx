import { CloudDownload } from 'lucide-react';
import { Button } from '@/components/ui';
import { useLiveJobs } from '@/lib/events';
import { useJobs, useStartJob } from '@/lib/queries';

export function PixivTagsButton() {
  const live = useLiveJobs((s) => s.jobs);
  const { data: jobs } = useJobs();
  const merged = new Map((jobs ?? []).map((j) => [j.id, j]));
  for (const j of Object.values(live)) merged.set(j.id, j);
  const running = [...merged.values()].find((j) => j.kind === 'pixiv-tags' && ['running', 'queued'].includes(j.status));
  const start = useStartJob(() => '已开始按 Pixiv 标签补充角色');
  return (
    <Button variant="secondary" icon={<CloudDownload className="size-4" />} disabled={!!running}
      loading={start.isPending} onClick={() => start.mutate('pixiv-tags')}
      title="查询未识别插画和漫画的 Pixiv 标签。单图或单角色直接关联，多图多角色给出建议。">
      {running ? `Pixiv ${running.total ? `${running.progress}/${running.total}` : '查询中'}` : '补充 Pixiv 角色'}
    </Button>
  );
}
