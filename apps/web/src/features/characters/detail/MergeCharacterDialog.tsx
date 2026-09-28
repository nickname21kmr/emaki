import type { Character, ID } from '@emaki/shared';
import { Command } from 'cmdk';
import { ArrowRight, Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Thumb } from '@/components/media/Thumb';
import { Button, Dialog, DialogFooter, Kbd, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useCharactersInfinite, useMutate, useSearch, useWorks } from '@/lib/queries';
import { EASE_OUT } from '@/lib/motion';

interface Candidate {
  character: Character;
  workName: string | null;
}

/**
 * 合并到其他角色：先搜目标（键盘上下选、回车确定），再看一眼「A → B」确认。
 * 合并后 A 被删除，所以成功后直接跳到 B 的详情页。
 */
export function MergeCharacterDialog({
  open,
  onOpenChange,
  character,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: Character;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="合并到其他角色"
      description={`把「${character.name}」的插画和别名并入另一个角色，常用来处理同一个人被建了两次的情况。`}
      width={520}
    >
      <MergeBody character={character} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function MergeBody({ character, onDone }: { character: Character; onDone: () => void }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<Candidate | null>(null);

  const merge = useMutate((targetId: ID) => api.mergeCharacter(character.id, targetId), {
    onSuccess: (_, targetId) => {
      onDone();
      navigate(`/characters/${targetId}`, { replace: true });
    },
  });

  return (
    <AnimatePresence mode="wait" initial={false}>
      {target ? (
        <motion.div
          key="confirm"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
        >
          <div className="flex items-center justify-center gap-6 rounded-lg bg-sunken py-6">
            <MiniCover character={character} caption="合并后删除" />
            <ArrowRight className="size-5 text-shu" aria-hidden />
            <MiniCover character={target.character} caption={target.workName ?? '保留'} />
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-fg-muted">
            「{character.name}」的 <span className="font-medium text-fg tabular">{formatCount(character.imageCount)}</span>{' '}
            张插画会归到「{target.character.name}」，它的名字和别名会成为「{target.character.name}」的别名。可以撤销。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              重新选择
            </Button>
            <Button variant="primary" loading={merge.isPending} onClick={() => merge.mutate(target.character.id)}>
              确认合并
            </Button>
          </DialogFooter>
        </motion.div>
      ) : (
        <motion.div
          key="pick"
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
        >
          <TargetPicker character={character} onPick={setTarget} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TargetPicker({ character, onPick }: { character: Character; onPick: (c: Candidate) => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 160);
  const search = useSearch(debounced);
  const { data: works } = useWorks();
  // 没输入时先列出同作品的角色（重复建的角色大多在同一部作品里）
  const sameWork = useCharactersInfinite({ workId: character.workIds[0], sort: 'imageCount', limit: 40 });

  const workName = useMemo(() => {
    const m = new Map((works ?? []).map((w) => [w.id, w.name]));
    return (id: ID | undefined) => (id ? (m.get(id) ?? null) : null);
  }, [works]);

  const candidates: Candidate[] = useMemo(() => {
    const list: Candidate[] = debounced
      ? (search.data ?? []).flatMap((h) =>
          h.type === 'character' ? [{ character: h.character, workName: h.workName }] : [],
        )
      : (sameWork.data?.pages.flatMap((p) => p.items) ?? []).map((c) => ({
          character: c,
          workName: workName(c.workIds[0]),
        }));
    return list.filter((c) => c.character.id !== character.id);
  }, [debounced, search.data, sameWork.data, workName, character.id]);

  const loading = debounced ? search.isPending : sameWork.isPending;

  return (
    <Command shouldFilter={false} loop label="选择合并目标" className="flex flex-col">
      <div className="flex h-10 items-center gap-2 rounded-full bg-sunken px-3.5 transition-shadow focus-within:bg-raised focus-within:shadow-[0_0_0_1px_var(--c-line-strong),0_0_0_4px_var(--c-shu-soft)]">
        <Search className="size-4 shrink-0 text-fg-subtle" />
        <Command.Input
          value={q}
          onValueChange={setQ}
          autoFocus
          placeholder="搜索要并入的角色（名字、别名、标签）"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div className="mt-3 mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-fg-subtle">
        {debounced ? '搜索结果' : character.workIds.length ? '同作品的角色' : '张数最多的角色'}
      </div>
      <Command.List className="-mx-1 h-[320px] overflow-y-auto px-1 scrollbar-thin">
        {loading ? (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-14 items-center gap-3 px-2.5">
              <Skeleton className="h-11 w-8 rounded-[6px]" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="mt-1.5 h-3 w-16" />
              </div>
            </div>
          ))
        ) : (
          <>
            <Command.Empty className="py-14 text-center text-[13px] text-fg-subtle">
              {debounced ? `没有找到「${debounced}」` : '同作品里没有其他角色，搜索一下试试'}
            </Command.Empty>
            {candidates.map((c) => (
              <Command.Item
                key={c.character.id}
                value={c.character.id}
                onSelect={() => onPick(c)}
                className="flex h-14 cursor-default items-center gap-3 rounded-md px-2.5 transition-colors duration-100 data-[selected=true]:bg-hover"
              >
                <CoverThumb character={c.character} className="h-11 w-8 rounded-[6px]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{c.character.name}</div>
                  <div className="truncate text-[11.5px] text-fg-subtle">
                    {c.workName ?? '无作品'}
                    {c.character.source === 'custom' && ' · 自建'}
                  </div>
                </div>
                <span className="text-xs text-fg-muted tabular">{formatCount(c.character.imageCount)} 张</span>
              </Command.Item>
            ))}
          </>
        )}
      </Command.List>
      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[11.5px] text-fg-subtle">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选择
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> 下一步
        </span>
      </div>
    </Command>
  );
}

function MiniCover({ character, caption }: { character: Character; caption: string }) {
  return (
    <div className="w-[92px] text-center">
      <CoverThumb character={character} className="h-[122px] w-full rounded-[10px] shadow-lift ring-1 ring-line" />
      <div className="mt-2 truncate text-[13px] font-medium">{character.name}</div>
      <div className="truncate text-[11px] text-fg-subtle">{caption}</div>
    </div>
  );
}

function CoverThumb({ character, className }: { character: Character; className: string }) {
  if (!character.coverImageId) {
    return (
      <div className={cn('flex shrink-0 items-center justify-center bg-sunken font-display text-lg text-fg-subtle', className)}>
        {character.name.slice(0, 1)}
      </div>
    );
  }
  return (
    <Thumb
      image={{ id: character.coverImageId, dominantColor: 'var(--c-sunken)', rating: character.coverRating }}
      width={240}
      focus={character.coverFocus}
      className={cn('shrink-0', className)}
    />
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
