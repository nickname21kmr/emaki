import type { PoseClass, PoseGroup } from '@emaki/shared';
import { PersonStanding, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Chip, Dialog, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { findPoseClass, usePoseClasses, usePoseOf, usePoseStatus } from './client';

/**
 * 按姿势找图（实验）的界面零件：图库工具条里的入口 / 已选的 chip、选类别的对话框、看图器信息里的一行。
 * 只在设置里打开后才懒加载（见 lazy.tsx）。
 */

/** 取景组在界面上的叫法（接口给的名字偏长） */
export const POSE_GROUP_LABEL: Record<PoseGroup, string> = { full: '全身', mid: '七分身', waist: '到腰半身', bust: '胸像' };

/** 示意小人：白底灰人，放在一小块白纸上（深色主题里也是白纸，像贴上去的图版） */
export function PoseFigure({ cls, size, className }: { cls: Pick<PoseClass, 'figureUrl'>; size: number; className?: string }) {
  return (
    <img
      src={cls.figureUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn('shrink-0 bg-white object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
}

// ------------------------------------------------------------------ 工具条入口

export interface PoseEntryProps {
  poseClass: string | undefined;
  /** 正按和某张图相近排（「找同姿势的图」） */
  liked: boolean;
  onPick: (id: string) => void;
  onClear: () => void;
}

/** 没选时是「按姿势」chip；选了是小人 + 类名 + 叉，点名字换一类 */
export function PoseEntry({ poseClass, liked, onPick, onClear }: PoseEntryProps) {
  const [open, setOpen] = useState(false);
  const classes = usePoseClasses(true);
  const cls = findPoseClass(classes.data, poseClass);
  return (
    <>
      {poseClass ? (
        <span className="inline-flex h-7 shrink-0 animate-fade-in items-center rounded-full bg-ink pr-1 text-xs font-medium text-fg-inverse">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={cls ? `${cls.description} · 点一下换一类` : '换一类姿势'}
            className="inline-flex h-full items-center gap-1.5 rounded-l-full pr-1 pl-1"
          >
            {cls ? <PoseFigure cls={cls} size={20} className="rounded-full" /> : <span className="size-5 rounded-full bg-fg-inverse/20" />}
            <span className="max-w-[12em] truncate">{cls?.name ?? '姿势'}</span>
            {liked && <span className="text-fg-inverse/60">· 按相近排</span>}
          </button>
          <button
            type="button"
            aria-label={`去掉姿势筛选${cls ? `「${cls.name}」` : ''}`}
            onClick={onClear}
            className="flex size-5 items-center justify-center rounded-full text-fg-inverse/60 hover:bg-fg-inverse/15 hover:text-fg-inverse"
          >
            <X className="size-3" />
          </button>
        </span>
      ) : (
        <Chip size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className="inline-flex items-center gap-1">
            <PersonStanding className="size-3.5" strokeWidth={1.8} aria-hidden />
            按姿势
          </span>
        </Chip>
      )}
      <PoseBrowser
        open={open}
        onOpenChange={setOpen}
        current={poseClass}
        onPick={(id) => {
          setOpen(false);
          onPick(id);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ 选类别

/** 方向键在格子间移动焦点：左右一格，上下找上一行 / 下一行里横向最近的那格 */
function moveFocus(e: KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!root || !keys.includes(e.key)) return;
  const cells = [...root.querySelectorAll<HTMLElement>('[data-pose-cell]')];
  const i = cells.indexOf(e.target as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  let target: HTMLElement | undefined;
  if (e.key === 'Home') target = cells[0];
  else if (e.key === 'End') target = cells.at(-1);
  else if (e.key === 'ArrowLeft') target = cells[i - 1];
  else if (e.key === 'ArrowRight') target = cells[i + 1];
  else {
    const me = cells[i]!.getBoundingClientRect();
    const down = e.key === 'ArrowDown';
    const rows = cells.filter((c) => {
      const r = c.getBoundingClientRect();
      return down ? r.top > me.top + 4 : r.top < me.top - 4;
    });
    if (rows.length) {
      // 最近的那一行
      const rowTop = down ? Math.min(...rows.map((c) => c.getBoundingClientRect().top)) : Math.max(...rows.map((c) => c.getBoundingClientRect().top));
      const row = rows.filter((c) => Math.abs(c.getBoundingClientRect().top - rowTop) < 4);
      target = row.reduce((best, c) => (Math.abs(c.getBoundingClientRect().left - me.left) < Math.abs(best.getBoundingClientRect().left - me.left) ? c : best));
    }
  }
  target?.focus();
  target?.scrollIntoView({ block: 'nearest' });
}

export function PoseBrowser({
  open,
  onOpenChange,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string | undefined;
  onPick: (id: string) => void;
}) {
  const classes = usePoseClasses(open);
  const status = usePoseStatus();
  const grid = useRef<HTMLDivElement>(null);
  // 换一类时打开：焦点落到当前选中的那格
  const loaded = !!classes.data;
  useEffect(() => {
    if (!open || !loaded || !current) return;
    const id = requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>('[data-pose-cell][aria-pressed="true"]')?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, loaded, current]);
  // 空的类别不显示，空的组整组不显示
  const groups = (classes.data?.groups ?? [])
    .map((g) => ({ ...g, classes: g.classes.filter((c) => c.count > 0) }))
    .filter((g) => g.classes.length > 0);
  const counts = status.data?.counts;
  const unclassified = counts ? Math.max(0, counts.processed - counts.classified) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={820}
      title="按姿势"
      description="按人物的姿势归类，点一类只看这一类，最典型的排在前面。"
    >
      <div
        ref={grid}
        onKeyDown={(e) => moveFocus(e, grid.current)}
        className="-mx-1 space-y-6"
      >
        {classes.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3 px-1">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="aspect-[4/5] rounded-[6px]" />
            ))}
          </div>
        ) : classes.isError ? (
          <p className="px-1 text-[13px] text-danger">{classes.error.message}</p>
        ) : groups.length === 0 ? (
          <p className="px-1 py-6 text-center text-[13px] text-fg-muted">
            还没有归了类的图。{counts?.pending ? `还有 ${formatCount(counts.pending)} 张在等提取姿势。` : ''}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.id} aria-labelledby={`pose-group-${g.id}`} className="px-1">
              <h3 id={`pose-group-${g.id}`} className="mb-2.5 flex items-baseline gap-3 text-[13px] font-semibold tracking-tight">
                {POSE_GROUP_LABEL[g.id]}
                <span className="text-[11.5px] font-normal text-fg-subtle tabular">{formatCount(g.count)} 张</span>
                <span aria-hidden className="h-px flex-1 translate-y-[-3px] bg-line" />
              </h3>
              <div role="list" className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3 gap-y-3">
                {g.classes.map((c) => {
                  const selected = c.id === current;
                  return (
                    <div role="listitem" key={c.id}>
                      <button
                        type="button"
                        data-pose-cell
                        aria-pressed={selected}
                        aria-label={`${c.description}，${c.count} 张`}
                        title={c.description}
                        onClick={() => onPick(c.id)}
                        className={cn(
                          'group/cell flex w-full flex-col items-stretch rounded-[8px] p-1.5 text-left transition-colors',
                          'hover:bg-hover',
                          selected && 'bg-hover',
                        )}
                      >
                        <PoseFigure
                          cls={c}
                          size={96}
                          className={cn('aspect-square !h-auto !w-full rounded-[6px] ring-1 ring-line', selected && 'ring-2 ring-ink')}
                        />
                        <span className="mt-1.5 line-clamp-2 text-[12px] leading-snug font-medium">{c.name}</span>
                        <span className="text-[11px] text-fg-subtle tabular">{formatCount(c.count)} 张</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
      {counts && (unclassified > 0 || counts.pending > 0) && (
        <p className="mt-5 border-t border-line pt-3 text-[12px] leading-relaxed text-fg-subtle">
          {unclassified > 0 && `另有 ${formatCount(unclassified)} 张没归类（没找到人物、露出的部位太少，或姿势不常见）。`}
          {counts.pending > 0 && `还有 ${formatCount(counts.pending)} 张没提取姿势。`}
        </p>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ 看图器信息

/** 信息面板「信息」里的一行：这张图的姿势类别（小字）和「找同姿势的图」。没有姿势结果就不占地方 */
export function PoseInfoRow({ imageId, onNavigate }: { imageId: string; onNavigate: () => void }) {
  const pose = usePoseOf(imageId, true);
  const classes = usePoseClasses(true);
  const classId = pose.data?.classId;
  if (!classId) return null;
  const cls = findPoseClass(classes.data, classId);
  const to = `/gallery?poseClass=${encodeURIComponent(classId)}&poseLike=${encodeURIComponent(imageId)}`;
  return (
    <>
      <dt className="text-fg-subtle">姿势</dt>
      <dd className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[12px] text-fg-muted" title={cls?.description}>
            {cls?.name ?? '…'}
          </span>
          <span aria-hidden className="text-fg-subtle">·</span>
          <Link to={to} onClick={onNavigate} className="text-fg-muted underline-offset-2 transition-colors hover:text-shu hover:underline">
            找同姿势的图
          </Link>
        </span>
      </dd>
    </>
  );
}
