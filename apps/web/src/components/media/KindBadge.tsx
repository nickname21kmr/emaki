import type { ContentKind } from '@emaki/shared';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { Seal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ANIMATED_LABEL, KIND_GLYPH, KIND_LABEL } from '@/lib/kinds';

/**
 * 缩略图上的类型朱文小印（T32b，SEL-5）：只给非插画显示。不自己定位，放进 TileMarks 那一行（网格左下角）。
 * 在「全部」视图里开，图库默认视图和别册里不开。
 */
export function KindBadge({ kind }: { kind: ContentKind }) {
  if (kind === 'illustration') return null;
  return (
    <span title={KIND_LABEL[kind]} className="flex">
      <Seal variant="zhu" size={16} glyph={KIND_GLYPH[kind]} />
    </span>
  );
}

/**
 * 动图标记（D5）：是否动图是另一个维度，不是类型，所以不用类型印（Seal 只给类型），
 * 叠在图上用一枚墨色小签：播放三角加一个「动」字，和组图张数角标同一种底色，克制、不抢图。
 */
export function AnimatedMark({ compact, className }: { /** 只有播放三角（很小的缩略图上） */ compact?: boolean; className?: string }) {
  if (compact)
    return (
      <span title={ANIMATED_LABEL} className={cn('flex size-4 items-center justify-center rounded-full bg-black/45 text-white/95', className)}>
        <Play className="size-2 translate-x-[0.5px] fill-current" strokeWidth={0} aria-hidden />
      </span>
    );
  return (
    <span
      title={ANIMATED_LABEL}
      className={cn(
        'flex h-4 items-center gap-[3px] rounded-full bg-black/45 pr-1.5 pl-[5px] text-[10px] leading-none font-semibold text-white/95',
        className,
      )}
    >
      <Play className="size-2 fill-current" strokeWidth={0} aria-hidden />动
    </span>
  );
}

/**
 * 纸面上的动图记号（目次、别册入口、看图器）：细线圆圈里一个播放三角，墨色。和朱色的类型印一眼分得开：
 * 类型是「印」，动图是筛选条件。
 */
export function AnimatedGlyph({ size = 20, className }: { size?: 16 | 20 | 24; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full border border-line-strong text-fg-muted', className)}
      style={{ width: size, height: size }}
    >
      <Play className="translate-x-[0.5px] fill-current" style={{ width: size * 0.4, height: size * 0.4 }} strokeWidth={0} />
    </span>
  );
}

/**
 * 网格格子左下角的一行小标记（RV-A-13：选择圈左上，模糊和组图张数右上，收藏右下，这一行左下）：
 * 调用方给的（类型印、合集页码）在前，动图标记在后。fadeOnHover：悬停时底部显示角色名，这一行淡出让位。
 */
export function TileMarks({ animated, children, fadeOnHover }: { animated: boolean; children?: ReactNode; fadeOnHover?: boolean }) {
  if (!animated && !children) return null;
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-1.5 left-1.5 z-[1] flex items-center gap-1',
        fadeOnHover && 'transition-opacity duration-300 group-hover/tile:opacity-0',
      )}
    >
      {children}
      {animated && <AnimatedMark />}
    </div>
  );
}
