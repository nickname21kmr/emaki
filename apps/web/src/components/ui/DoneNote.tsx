import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useBriefGuard } from '@/lib/guard';
import { undo } from '@/lib/queries';
import { cn } from '@/lib/cn';
import { Button } from './Button';

/**
 * 处理过的行原地显示「已整理 · 撤销」。撤销按钮正好落在原来那个按钮的位置，
 * 所以出现后先禁用 400ms，连点两下不会把刚做的又撤回去。
 */
export function DoneNote({ label, token, className }: { label: string; token: string | null; className?: string }) {
  const client = useQueryClient();
  const guard = useBriefGuard();
  const [undoing, setUndoing] = useState(false);
  const arm = guard.arm;
  useEffect(arm, [arm]);
  return (
    <span role="status" className={cn('inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted', className)}>
      <Check className="size-3.5 text-ok" aria-hidden />
      {label}
      {token && (
        <>
          <span aria-hidden>·</span>
          <Button
            size="sm"
            variant="ghost"
            loading={undoing}
            disabled={guard.active}
            onClick={() => {
              if (guard.isActive()) return;
              setUndoing(true);
              void undo(token, client).finally(() => setUndoing(false));
            }}
          >
            撤销
          </Button>
        </>
      )}
    </span>
  );
}
