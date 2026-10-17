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
      title="会联网：把未识别插画和漫画文件名里的 Pixiv 作品号发给 pixiv.net，读公开标签来补角色，不上传图片。打开了 Danbooru 联网同步时，还会拿不认识的 Pixiv 标签去 Danbooru 查角色名。投稿里的作品标签能确认角色、并且是单图或单角色的直接关联，其余只给建议；Pixiv 标了原创的归为原创。设置里没打开自动查时也能手动点。">
      {running ? `Pixiv ${running.total ? `${running.progress}/${running.total}` : '查询中'}` : '补充 Pixiv 角色'}
    </Button>
  );
}
