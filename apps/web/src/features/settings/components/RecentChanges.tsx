import type { ChangeEntry, ChangeGroup } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, DialogFooter } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCount, formatDateTime, formatRelative } from '@/lib/format';
import { useMutate } from '@/lib/queries';

const COLLAPSED = 5;

const TEXT: Record<ChangeGroup, { title: string; hint: string; action: string; confirm: string }> = {
  auto: {
    title: '最近的自动改动',
    hint: '后台自动给自建角色绑 Danbooru 标签、Pixiv 补充加角色时记在这里，重启后也能撤回。',
    action: '撤回',
    confirm: '撤回这条自动改动？',
  },
  move: {
    title: '最近的移动',
    hint: '「移动到文件夹」的记录，重启后也能移回原处。之后又动过的文件会跳过并列出来。',
    action: '移回原处',
    confirm: '移回原处？',
  },
};

/** 设置里的「最近的自动改动」/「最近的移动」：一行一条，带撤回按钮（先确认） */
export function RecentChanges({ group }: { group: ChangeGroup }) {
  const text = TEXT[group];
  const { data } = useQuery({ queryKey: ['changes', group], queryFn: () => api.changes(group) });
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<ChangeEntry | null>(null);
  const revert = useMutate((id: string) => api.revertChange(id), { label: text.action });
  const list = data ?? [];
  const visible = expanded ? list : list.slice(0, COLLAPSED);

  return (
    <div className="py-3.5">
      <div className="text-sm font-medium">{text.title}</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{text.hint}</div>
      {list.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-fg-subtle">还没有记录。</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {visible.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px]" title={c.summary}>
                  {c.summary}
                </div>
                <div className="mt-0.5 text-[12px] text-fg-subtle" title={formatDateTime(c.createdAt)}>
                  {formatRelative(c.createdAt)}
                  {c.revertedAt && ' · 已撤回'}
                  {c.note && <span className="text-danger"> · {c.note}</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Undo2 />}
                disabled={!c.revertable}
                title={c.revertable ? undefined : c.revertHint}
                onClick={() => setPending(c)}
              >
                {text.action}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {list.length > COLLAPSED && (
        <Button variant="ghost" size="sm" className="mt-1 h-auto px-1 py-0 text-[12.5px]" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `显示全部 ${list.length} 条`}
        </Button>
      )}
      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title={text.confirm} description={pending?.summary} width={460}>
        <p className="text-[13px] leading-relaxed">{pending?.revertHint}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPending(null)}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<Undo2 />}
            loading={revert.isPending}
            onClick={() => {
              if (!pending) return;
              revert.mutate(pending.id, { onSettled: () => setPending(null) });
            }}
          >
            {text.action}
            {pending?.count ? `（${formatCount(pending.count)} 张）` : ''}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
