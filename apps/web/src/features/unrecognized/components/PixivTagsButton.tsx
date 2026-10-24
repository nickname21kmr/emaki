import { ChevronDown, CloudDownload, RefreshCw } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui';
import { useLiveJobs } from '@/lib/events';
import { useJobs, useStartJob } from '@/lib/queries';
import { useJobResultToast } from '@/features/settings/useJobResultToast';
import { cn } from '@/lib/cn';
import { HeaderAction } from './HeaderAction';

/**
 * 「Pixiv 补角色」：按插画的 Pixiv 标签补角色。主按钮 + 右侧小箭头（重新联网读标签）拼成一个分体按钮，
 * 中间一道细线分开，不再是两块。运行中主按钮显示进度，例如「Pixiv 12/80」。
 */
export function PixivTagsButton() {
  const live = useLiveJobs((s) => s.jobs);
  const { data: jobs } = useJobs();
  const merged = new Map((jobs ?? []).map((j) => [j.id, j]));
  for (const j of Object.values(live)) merged.set(j.id, j);
  const running = [...merged.values()].find((j) => j.kind === 'pixiv-tags' && ['running', 'queued'].includes(j.status));
  const start = useStartJob(() => '已开始按 Pixiv 标签补充角色');
  // 结束时把「原创 / 不可访问 / 失败」这些结果弹出来
  const arm = useJobResultToast('pixiv-tags');
  return (
    <div className="inline-flex items-center">
      <HeaderAction icon={<CloudDownload />} disabled={!!running} className={cn('rounded-r-none border-r-0 tabular', running && 'disabled:opacity-100')}
        loading={start.isPending} onClick={() => { arm(); start.mutate('pixiv-tags'); }}
        tip="按插画的 Pixiv 标签找角色：能确定的直接归入，其余给出建议，标了原创的归为原创。">
        {running ? `Pixiv ${running.total ? `${running.progress}/${running.total}` : '查询中'}` : 'Pixiv 补角色'}
      </HeaderAction>
      <Menu trigger={<HeaderAction className="rounded-l-none px-2" aria-label="Pixiv 补角色的更多选项" tip="更多选项" disabled={!!running || start.isPending}><ChevronDown /></HeaderAction>}>
        <MenuItem icon={<RefreshCw />} onSelect={() => { arm(); start.mutate({ kind: 'pixiv-tags', refreshPixiv: true }); }}>重新获取 Pixiv 标签</MenuItem>
        <p className="max-w-60 px-2 py-1 text-xs leading-relaxed text-fg-muted">重新联网读取当前待补投稿的标签。</p>
      </Menu>
    </div>
  );
}
