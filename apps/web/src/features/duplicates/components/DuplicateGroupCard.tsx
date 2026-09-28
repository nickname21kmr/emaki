import type { DuplicateGroup, ID, LibraryRoot } from '@emaki/shared';
import { Equal, ZoomIn } from 'lucide-react';
import { motion } from 'motion/react';
import { forwardRef, useEffect, useMemo, useState } from 'react';
import { Badge, Button, IconButton, Kbd } from '@/components/ui';
import { imageUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import {
  bestValues,
  FOLDED_ROWS,
  folderOf,
  kindLabel,
  PER_ROW,
  reclaimBytes,
  splitCommon,
  TILE_GAP,
  TILE_HEIGHT,
  tileRatio,
} from '../utils';
import { DuplicateTile } from './DuplicateTile';

/**
 * 一组重复：顶部类型 + 张数，中间等高的图片（每行最多 PER_ROW 张，下方对比信息），底部操作。
 * forwardRef 是给 AnimatePresence 的 popLayout 用的。
 */
export const DuplicateGroupCard = forwardRef<
  HTMLElement,
  {
    group: DuplicateGroup;
    /** 列表里的序号（从 0 开始） */
    index: number;
    keepIds: ID[];
    active: boolean;
    busy: boolean;
    roots: ReadonlyMap<ID, LibraryRoot>;
    onActivate: () => void;
    onToggle: (imageId: ID) => void;
    onResolve: () => void;
    onIgnore: () => void;
    onOpen: (imageIndex: number) => void;
    /** 放大对比（TR-5，只对相似组） */
    lensOn: boolean;
    onToggleLens: () => void;
  }
>(function DuplicateGroupCard(
  { group, index, keepIds, active, busy, roots, onActivate, onToggle, onResolve, onIgnore, onOpen, lensOn, onToggleLens },
  ref,
) {
  const best = useMemo(() => bestValues(group.images), [group.images]);
  const folders = useMemo(() => group.images.map((img) => folderOf(img, roots)), [group.images, roots]);
  const parts = useMemo(() => (group.kind === 'exact' ? splitCommon(folders.map((x) => x.short)) : null), [group.kind, folders]);
  // 同步放大镜：组内每张显示同一相对位置的 3 倍放大；打开时先把原图拉下来
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const lensActive = lensOn && group.kind === 'similar';
  useEffect(() => {
    if (!lensActive) return setLens(null);
    for (const img of group.images) new Image().src = imageUrl.file(img.id);
  }, [lensActive, group.images]);
  const ratios = group.images.map(tileRatio);
  // 每行最多 PER_ROW 张；超过 FOLDED_ROWS 行先折起来（几十张的组挤成一行会小得看不清）
  const [expanded, setExpanded] = useState(false);
  const rows: number[][] = [];
  for (let k = 0; k < ratios.length; k += PER_ROW) rows.push(ratios.slice(k, k + PER_ROW).map((_, j) => k + j));
  const shownRows = expanded ? rows : rows.slice(0, FOLDED_ROWS);
  const hidden = ratios.length - shownRows.reduce((n, r) => n + r.length, 0);
  const rowSum = (r: number[]) => r.reduce((a, k) => a + ratios[k]!, 0);
  const firstSum = rowSum(rows[0]!);
  const trashCount = group.images.length - keepIds.length;
  const reclaim = reclaimBytes(group, keepIds);

  return (
    <motion.section
      ref={ref}
      id={`dup-${group.id}`}
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 40 }}
      onClick={onActivate}
      aria-label={`第 ${index + 1} 组重复`}
      aria-current={active || undefined}
      className={cn(
        'relative scroll-mt-44 rounded-[18px] bg-raised p-5 ring-1 transition-[box-shadow] duration-300',
        active ? 'shadow-lift ring-line-strong' : 'ring-line hover:ring-line-strong',
      )}
    >
      {/* 当前组：左边一道朱色细线，像夹在卷轴里的书签；J / K 时在组间滑动 */}
      {active && (
        <motion.span
          layoutId="dup-active-mark"
          aria-hidden
          className="absolute top-6 bottom-6 -left-px w-[3px] rounded-r-full bg-shu"
          transition={{ type: 'spring', stiffness: 380, damping: 36 }}
        />
      )}

      <header className="mb-4 flex items-center gap-3">
        <span className={cn('numeral w-9 text-[28px] tabular transition-colors duration-300', active ? 'text-shu' : 'text-fg-subtle')}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <Badge tone={group.kind === 'exact' ? 'ok' : 'neutral'}>
          {group.kind === 'exact' && <Equal className="size-3" strokeWidth={2.5} />}
          {kindLabel(group)}
        </Badge>
        <span className="text-[13px] text-fg-muted tabular">{group.images.length} 张</span>
        {group.kind === 'similar' && (
          <IconButton
            label="放大对比"
            shortcut="Z"
            size="sm"
            active={lensActive}
            className="ml-auto"
            onClick={(e) => {
              e.stopPropagation();
              onToggleLens();
            }}
          >
            <ZoomIn />
          </IconButton>
        )}
        <span className={cn('text-[12px] text-fg-subtle tabular', group.kind !== 'similar' && 'ml-auto')}>
          可释放 <span className="font-medium text-fg-muted">{formatBytes(reclaim)}</span>
        </span>
      </header>

      {/* 等高行：每张宽度按比例分配；最大高度 TILE_HEIGHT，容器变窄时整行等比缩小。
          后面的行（最后一行往往不满）宽度不超过第一行按比例的份额，保证各行一样高 */}
      <div className="flex flex-col" style={{ gap: TILE_GAP }}>
        {shownRows.map((row, r) => {
          const sum = rowSum(row);
          const natural = `calc(${sum} * ${TILE_HEIGHT}px + ${(row.length - 1) * TILE_GAP}px)`;
          return (
            <div
              key={r}
              className="flex items-start"
              style={{ gap: TILE_GAP, maxWidth: r === 0 ? natural : `min(${natural}, ${((sum / firstSum) * 100).toFixed(3)}%)` }}
            >
              {row
                .map((k) => group.images[k]!)
                .map((img, j) => {
                  const k = row[j]!;
                  return (
                    <DuplicateTile
                      key={img.id}
                      image={img}
                      ratio={ratios[k]!}
                      kept={keepIds.includes(img.id)}
                      suggested={img.id === group.suggestedKeepId}
                      bestResolution={best.resolution.has(img.id)}
                      bestBytes={best.bytes.has(img.id)}
                      folder={folders[k]!}
                      folderParts={parts?.[k]}
                      lens={lensActive ? lens : null}
                      onLensMove={lensActive ? (x, y) => setLens({ x, y }) : undefined}
                      onLensLeave={() => setLens(null)}
                      onToggle={() => onToggle(img.id)}
                      onOpen={() => onOpen(k)}
                    />
                  );
                })}
            </div>
          );
        })}
        {rows.length > FOLDED_ROWS && (
          <button
            type="button"
            className="self-start rounded-full px-3 py-1 text-[12.5px] text-fg-muted ring-1 ring-line transition-colors hover:bg-hover hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? '收起' : `展开全部 ${group.images.length} 张（还有 ${hidden} 张）`}
          </button>
        )}
      </div>

      <footer className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <p className="text-[12.5px] text-fg-muted tabular">
          {trashCount > 0 ? (
            <>
              保留 <span className="font-semibold text-fg">{keepIds.length}</span> 张 ·{' '}
              <span className="font-semibold text-fg">{trashCount}</span> 张移到回收站
            </>
          ) : (
            '全部保留，只标记为已处理'
          )}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onIgnore} disabled={busy}>
            不是重复
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onResolve}
            loading={busy}
            trailing={
              active && !busy ? (
                <Kbd tone="inverse" className="ml-0.5">
                  ↵
                </Kbd>
              ) : undefined
            }
          >
            {trashCount > 0 ? '保留选中，其余移到回收站' : '全部保留'}
          </Button>
        </div>
      </footer>
    </motion.section>
  );
});
