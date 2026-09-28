import type { Exclusion, ID } from '@emaki/shared';
import { Check, ImageOff, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { Button, SectionTitle, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, formatRelative } from '@/lib/format';
import { useImage } from '@/lib/queries';
import { useLightbox } from '@/lib/stores';
import type { SinglesSelection } from '../useSinglesSelection';
import { ruleTitle } from '../utils';

/** 一次最多先铺这么多，单独排除通常不多；多了再展开 */
const LIMIT = 48;

/**
 * 单独排除的图片：小网格 + 多选恢复。
 * 交互和图库网格一致：单击看大图（已有选中时改为切换选中），Ctrl/⌘ 单击切换，Shift 连选。
 */
export function SingleImagesSection({
  singles,
  selection,
  busyId,
  onRestore,
}: {
  singles: Exclusion[];
  selection: SinglesSelection;
  /** 正在恢复的排除记录 id */
  busyId: ID | null;
  onRestore: (e: Exclusion) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const showLightbox = useLightbox((s) => s.show);
  const ids = useMemo(() => singles.map((s) => s.target), [singles]);
  const shown = expanded ? singles : singles.slice(0, LIMIT);
  const selecting = selection.selected.size > 0;

  const onTileClick = (e: React.MouseEvent, id: ID, index: number) => {
    if (e.shiftKey) return selection.range(id);
    if (e.ctrlKey || e.metaKey || selecting) return selection.toggle(id);
    showLightbox(ids, index);
  };

  return (
    <section>
      <SectionTitle hint={`${formatCount(singles.length)} 张 · 在图库或看图器里按 E 排除的`}>单张图片</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2.5">
        {shown.map((ex, i) => (
          <SingleTile
            key={ex.id}
            exclusion={ex}
            selected={selection.selected.has(ex.target)}
            selecting={selecting}
            busy={busyId === ex.id}
            onClick={(e) => onTileClick(e, ex.target, i)}
            onToggle={() => selection.toggle(ex.target)}
            onRestore={() => onRestore(ex)}
          />
        ))}
      </div>
      {singles.length > LIMIT && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `显示全部 ${formatCount(singles.length)} 张`}
          </Button>
        </div>
      )}
    </section>
  );
}

function SingleTile({
  exclusion,
  selected,
  selecting,
  busy,
  onClick,
  onToggle,
  onRestore,
}: {
  exclusion: Exclusion;
  selected: boolean;
  selecting: boolean;
  busy: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onRestore: () => void;
}) {
  // 列表只给了图片 id；取详情是为了主色占位和分级（敏感图遵守模糊偏好）
  const { data: image, isError } = useImage(exclusion.target);
  const name = ruleTitle(exclusion);

  return (
    <div
      className={cn(
        'group/tile relative aspect-[3/4] overflow-hidden rounded-[10px] bg-sunken transition-[scale,box-shadow,opacity] duration-300 ease-[var(--ease-out-soft)]',
        selected ? 'scale-[0.94] shadow-[0_0_0_3px_var(--c-shu)]' : 'hover:shadow-lift',
        busy && 'opacity-50',
      )}
    >
      <button type="button" onClick={onClick} className="block size-full cursor-zoom-in" aria-label={name}>
        {image ? (
          <Thumb image={image} width={480} className="size-full" imgClassName="group-hover/tile:[transform:scale(1.03)]" />
        ) : isError ? (
          <span className="flex size-full items-center justify-center text-fg-subtle">
            <ImageOff className="size-5" />
          </span>
        ) : (
          <span className="skeleton block size-full rounded-none" />
        )}
      </button>

      {/* 悬停：底部文件名 + 排除时间 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 scrim-bottom opacity-0 transition-opacity duration-300 group-hover/tile:opacity-100" />
      <div className="pointer-events-none absolute inset-x-2.5 bottom-2 translate-y-1 text-white opacity-0 transition-[opacity,translate] duration-300 group-hover/tile:translate-y-0 group-hover/tile:opacity-100">
        <div className="truncate text-[12px] font-medium">{name}</div>
        <div className="text-[11px] text-white/70">{formatRelative(exclusion.createdAt)}排除</div>
      </div>

      <button
        type="button"
        aria-label={selected ? '取消选择' : '选择'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className={cn(
          'absolute top-2 left-2 flex size-6 items-center justify-center rounded-full transition-all duration-200',
          selected
            ? 'bg-shu text-white opacity-100'
            : 'bg-black/20 text-transparent opacity-0 ring-2 ring-white/90 backdrop-blur-sm group-hover/tile:opacity-100 hover:bg-black/40 hover:text-white/80',
          selecting && !selected && 'opacity-100',
        )}
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>

      {!selecting && (
        <Tooltip content="恢复这张">
          <button
            type="button"
            aria-label={`恢复：${name}`}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/40 text-white opacity-0 ring-1 ring-white/15 backdrop-blur-md transition-[opacity,background-color] duration-200 group-hover/tile:opacity-100 hover:bg-black/60 focus-visible:opacity-100"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
