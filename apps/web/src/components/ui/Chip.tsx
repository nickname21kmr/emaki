import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { SPRING } from '@/lib/motion';
import type { ID, Rating } from '@emaki/shared';
import { Thumb } from '@/components/media/Thumb';
import { formatCount } from '@/lib/format';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  /** 左侧：头像 / 色点 / 图标 */
  leading?: ReactNode;
  count?: number;
  size?: 'sm' | 'md';
  /** 给一组 chip 同一个 layoutId：选中的墨色底块会在组内滑动（SEL-15） */
  ink?: string;
}

/**
 * 筛选 chip。选中态是「墨色实心」，和截图里的「总览」一致。
 */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected, leading, count, size = 'md', ink, className, children, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  return (
    <button
      ref={ref}
      aria-pressed={selected}
      className={cn(
        'group inline-flex shrink-0 items-center rounded-full font-medium whitespace-nowrap select-none',
        'transition-[background-color,color,box-shadow,scale] duration-200 active:scale-[0.96]',
        ink && 'relative isolate duration-[180ms]',
        size === 'md' ? 'h-8 gap-1.5 text-[13px]' : 'h-7 gap-1 text-xs',
        leading ? (size === 'md' ? 'pr-3 pl-1' : 'pr-2.5 pl-1') : size === 'md' ? 'px-3.5' : 'px-2.5',
        selected && ink
          ? 'text-fg-inverse'
          : selected
          ? 'bg-ink text-fg-inverse shadow-[0_4px_14px_-6px_rgb(0_0_0/0.45)]'
          : 'bg-raised text-fg shadow-[0_0_0_1px_var(--c-line)] hover:shadow-[0_0_0_1px_var(--c-line-strong)] hover:bg-hover',
        className,
      )}
      {...rest}
    >
      {/* 墨块：同一组 chip 共用一个 layoutId，切换时从旧 chip 滑到新 chip（SEL-15） */}
      {selected && ink && (
        <motion.span
          layoutId={ink}
          aria-hidden
          className="absolute inset-0 -z-10 rounded-full bg-ink shadow-[0_4px_14px_-6px_rgb(0_0_0/0.45)]"
          transition={reduce ? { duration: 0 } : SPRING}
        />
      )}
      {leading}
      <span>{children}</span>
      {count !== undefined && (
        <span className={cn('tabular text-[11px]', selected ? 'text-fg-inverse/60' : 'text-fg-subtle')}>
          {formatCount(count)}
        </span>
      )}
    </button>
  );
});

/** chip 左侧的小圆头像（图片或色块） */
/** 头像用的图：走 Thumb，跟着模糊开关走（MG-5） */
export interface ChipAvatarImage {
  id: ID;
  rating: Rating;
  color?: string | null;
}

export function ChipAvatar({ image, color, label }: { image?: ChipAvatarImage | null; color?: string; label?: string }) {
  return (
    <span
      className="relative inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold text-white"
      style={{ background: color ?? 'var(--c-sunken)' }}
    >
      {image ? (
        <Thumb
          image={{ id: image.id, rating: image.rating, dominantColor: image.color ?? color ?? 'var(--c-sunken)' }}
          width={240}
          blurBadge="none"
          className="absolute inset-0"
        />
      ) : (
        label?.slice(0, 1)
      )}
    </span>
  );
}
