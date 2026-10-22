import type { CustomCharacterMatch } from '@emaki/shared';
import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Dialog, DialogFooter } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useCustomCharacterMatches, useMutate } from '@/lib/queries';

/** 匹配结果可直接处理；自建筛选与关联是两个独立入口。 */
export function CustomMatchPill({ count, onViewCustom }: { count: number; onViewCustom: () => void }) {
  const [open, setOpen] = useState(false);
  const matches = useCustomCharacterMatches(open);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn('inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] whitespace-nowrap transition-colors',
          count > 0 ? 'bg-shu-soft text-shu-fg hover:bg-hover' : 'bg-sunken text-fg-muted hover:bg-hover hover:text-fg')}
      >
        <Link2 className="size-3.5" aria-hidden />
        {count > 0 ? `${formatCount(count)} 个 Danbooru 关联待确认` : 'Danbooru 关联'}
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="关联 Danbooru 角色" width={600}
        description="名称精确匹配、身份唯一且作品无冲突时，会自动关联。下面列出需要你选择的匹配。">
        {matches.isPending ? <p className="py-5 text-sm text-fg-muted">正在读取匹配结果…</p>
          : matches.isError ? <div className="py-5 text-sm text-fg-muted">读取失败。<Button variant="ghost" onClick={() => matches.refetch()}>重试</Button></div>
          : matches.data.length ? <div className="flex flex-col gap-3">{matches.data.map((match) => <MatchRow key={match.characterId} match={match} />)}</div>
          : <p className="py-5 text-sm text-fg-muted">当前没有待确认的匹配。</p>}
        <details className="mt-4 text-xs leading-relaxed text-fg-muted">
          <summary className="cursor-pointer">自动关联条件</summary>
          <p className="mt-2">名字或别名须与词库中的角色名精确匹配；排除作品冲突、将服装变体归到本体后，只对应一个角色。仅昵称或标签简写匹配时，还须所属作品一致。</p>
          <p className="mt-1">同标签已有角色、多个自建角色争用标签，留在这里处理；已忽略的匹配保持忽略。投稿量不用于自动选择。</p>
        </details>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { setOpen(false); onViewCustom(); }}>查看自建角色</Button>
          <Button onClick={() => setOpen(false)}>完成</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

export function MatchRow({ match }: { match: CustomCharacterMatch }) {
  const apply = useMutate(() => match.existingCharacterId
    ? api.mergeCharacter(match.characterId, match.existingCharacterId)
    : api.updateCharacter(match.characterId, { danbooruTag: match.danbooruTag }));
  return (
    <div className="rounded-lg border border-line bg-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/characters/${match.characterId}`} className="font-medium text-fg hover:text-shu">{match.characterName}</Link>
          <div className="mt-1 text-sm text-fg-muted">对应：{match.matchName}{match.workName ? ` · ${match.workName}` : ''}</div>
          <div className="mt-1 break-all text-xs text-fg-dim">{match.danbooruTag}</div>
        </div>
        <Button size="sm" variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
          {match.existingCharacterId ? `合并到「${match.existingCharacterName}」` : '确认关联'}
        </Button>
      </div>
      {match.existingCharacterId && <p className="mt-3 text-xs leading-relaxed text-fg-muted">将图片和别名并入已有角色，可以撤销。</p>}
    </div>
  );
}
