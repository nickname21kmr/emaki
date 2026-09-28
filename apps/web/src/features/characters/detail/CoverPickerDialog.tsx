import type { Character, CoverCandidate, ID } from '@emaki/shared';
import { Check, RotateCcw } from 'lucide-react';
import { motion, useReducedMotion, type Variants } from 'motion/react';
import { Thumb } from '@/components/media/Thumb';
import { Button, Dialog, DialogFooter, ErrorState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { EASE_OUT } from '@/lib/motion';
import { useCoverCandidates, useMutate } from '@/lib/queries';

const LIMIT = 12;
/** 自动封面没有焦点时前端统一的兜底（CB-8） */
const FOCUS_FALLBACK = { x: 0.5, y: 0.15 };

const panel = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.25, ease: EASE_OUT },
};
const grid: Variants = { show: { transition: { staggerChildren: 0.02 } } };
const cell: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } },
};

/**
 * 「换封面」候选面板（CB-7）：按自动封面的评分列出前 12 张，点一张就设为封面。
 * 底部左边「恢复自动」（手动设过时可点），右边「在全部插画里挑」回到旧流程（滚到插画区 + 提示）。
 */
export function CoverPickerDialog({
  open,
  onOpenChange,
  character,
  tint,
  onPickFromAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: Character;
  /** 缩略图加载前的底色兜底 */
  tint: string;
  onPickFromAll: () => void;
}) {
  const reduce = useReducedMotion();
  const { data, isPending, isError, error, refetch } = useCoverCandidates(character.id, LIMIT, open);
  const setCover = useMutate((imageId: ID | null) => api.updateCharacter(character.id, { coverImageId: imageId }), {
    onSuccess: () => onOpenChange(false),
  });

  const items = data?.items ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="换封面"
      description="按自动选封面的评分排好了，点一张就换上。"
      width={600}
    >
      <motion.div {...(reduce ? { initial: false } : panel)}>
        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isPending ? (
          <div className="grid grid-cols-4 gap-3" aria-busy>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-[10px]" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-[10px] bg-sunken px-4 py-10 text-center text-[13px] text-fg-muted">
            这个角色还没有适合当封面的插画。
          </p>
        ) : (
          <motion.ul
            className="grid grid-cols-4 gap-3"
            variants={grid}
            initial={reduce ? false : 'hidden'}
            animate="show"
            aria-label="候选封面"
          >
            {items.map((item, i) => (
              <motion.li key={item.id} variants={reduce ? undefined : cell}>
                <CandidateButton
                  item={item}
                  index={i}
                  tint={tint}
                  current={item.id === character.coverImageId}
                  focus={(item.id === character.coverImageId && character.coverFocus) || FOCUS_FALLBACK}
                  disabled={setCover.isPending}
                  onPick={() => (item.id === character.coverImageId && character.coverManual ? onOpenChange(false) : setCover.mutate(item.id))}
                />
              </motion.li>
            ))}
          </motion.ul>
        )}
      </motion.div>

      <DialogFooter>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw />}
          disabled={!character.coverManual || setCover.isPending}
          onClick={() => setCover.mutate(null)}
          className="mr-auto -ml-2.5"
        >
          恢复自动
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onOpenChange(false);
            // 等弹窗关掉、焦点还给触发按钮之后再滚动，免得两者抢
            window.setTimeout(onPickFromAll, 0);
          }}
          className="-mr-2.5"
        >
          在全部插画里挑
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function CandidateButton({
  item,
  index,
  tint,
  current,
  focus,
  disabled,
  onPick,
}: {
  item: CoverCandidate;
  index: number;
  tint: string;
  current: boolean;
  focus: { x: number; y: number };
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      aria-label={`第 ${index + 1} 张${current ? '（当前封面）' : ''}：${item.fileName}`}
      aria-pressed={current}
      title={`${item.width}×${item.height} · 评分 ${item.coverScore}`}
      className={cn(
        'group/reveal relative block w-full rounded-[10px] outline-none transition-[scale,box-shadow] duration-200',
        'hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-shu/60 focus-visible:ring-offset-2 focus-visible:ring-offset-raised',
        'disabled:cursor-wait',
        current && 'ring-2 ring-shu ring-offset-2 ring-offset-raised',
      )}
    >
      <Thumb
        image={{ id: item.id, dominantColor: item.dominantColor ?? tint, rating: item.rating, kind: item.kind }}
        width={480}
        focus={focus}
        revealOnHover
        blurBadge="corner"
        className="aspect-[3/4] rounded-[10px]"
      />
      {current && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex h-5 items-center gap-1 rounded-full bg-shu px-2 text-[11px] font-medium text-white shadow-sm">
          <Check className="size-3" />
          当前
        </span>
      )}
    </button>
  );
}
