import type { Character } from '@emaki/shared';
import { Ban } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, Dialog, DialogFooter } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { useMutate } from '@/lib/queries';

/**
 * 排除整个角色（建一条 kind=character 的排除规则）。
 * 这个角色的图全部隐藏后详情页就空了，所以成功后回到角色列表；toast 里可以撤销。
 */
export function ExcludeCharacterDialog({
  open,
  onOpenChange,
  character,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: Character;
}) {
  const navigate = useNavigate();
  const exclude = useMutate(() => api.createExclusion({ kind: 'character', target: character.id }), {
    onSuccess: () => {
      onOpenChange(false);
      navigate('/characters');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`排除「${character.name}」？`} width={440}>
      <div className="flex gap-3.5 rounded-lg bg-sunken p-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
          <Ban className="size-4" />
        </span>
        <p className="text-[13px] leading-relaxed text-fg-muted">
          TA 的 <span className="font-medium text-fg tabular">{formatCount(character.imageCount)}</span>{' '}
          张插画会从图库和统计里隐藏，文件本身不会被删除。之后可以在「已排除」里随时恢复。
        </p>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button variant="danger" loading={exclude.isPending} onClick={() => exclude.mutate(undefined)}>
          排除这个角色
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
