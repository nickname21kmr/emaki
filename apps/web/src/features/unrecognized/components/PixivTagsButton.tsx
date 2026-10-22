import { ChevronDown, CloudDownload, RefreshCw } from 'lucide-react';
import { Button, Menu, MenuItem } from '@/components/ui';
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
    <div className="inline-flex items-center gap-0.5">
      <Button variant="secondary" icon={<CloudDownload className="size-4" />} disabled={!!running}
        loading={start.isPending} onClick={() => start.mutate('pixiv-tags')}
        title="优先用已缓存的 Pixiv 标签补充角色，新投稿和之前获取失败的投稿再联网查询。打开 Danbooru 联网同步时，也会查询尚未匹配的角色名。符合规则的直接关联，其余给出建议；Pixiv 标了原创的归为原创。">
        {running ? `Pixiv ${running.total ? `${running.progress}/${running.total}` : '查询中'}` : '补充 Pixiv 角色'}
      </Button>
      <Menu trigger={<Button variant="secondary" className="px-2" aria-label="Pixiv 补充选项" title="Pixiv 补充选项" disabled={!!running || start.isPending}><ChevronDown className="size-4" /></Button>}>
        <MenuItem icon={<RefreshCw />} onSelect={() => start.mutate({ kind: 'pixiv-tags', refreshPixiv: true })}>重新获取 Pixiv 标签</MenuItem>
        <p className="max-w-60 px-2 py-1 text-xs leading-relaxed text-fg-muted">重新联网读取当前待补投稿的标签。</p>
      </Menu>
    </div>
  );
}
