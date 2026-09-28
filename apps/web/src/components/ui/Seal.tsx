import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SPRING } from '@/lib/motion';

/**
 * 印章（SEL-4，T29b-5）：朱文（描边）用于类型、作品这类「标记」；白文（实底，微微歪）只用于「新」「自」和合集的书名印。
 * animateIn：像盖章一样从大到小落下，index 用来错峰；系统开了减少动效时直接出现。
 */
export function Seal({
  glyph,
  variant = 'zhu',
  size = 20,
  className,
  animateIn,
  index,
}: {
  glyph: ReactNode;
  variant?: 'zhu' | 'bai';
  size?: 16 | 20 | 24;
  className?: string;
  animateIn?: boolean;
  index?: number;
}) {
  const reduce = useReducedMotion();
  const bai = variant === 'bai';
  const style = bai ? undefined : { width: size, height: size, fontSize: Math.round(size * 0.6) };
  const cls = cn(
    bai
      ? 'inline-flex h-5 items-center rounded-[3px] bg-seal px-1.5 text-[12px] leading-none font-semibold text-white -rotate-[5deg]'
      : 'inline-flex shrink-0 items-center justify-center rounded-[3px] border-[1.5px] border-shu bg-sheet/85 font-serif-cjk leading-none font-black text-shu',
    !bai && size >= 20 && 'shadow-[inset_0_0_0_2px_var(--c-sheet),inset_0_0_0_2.75px_color-mix(in_oklab,var(--c-shu)_50%,transparent)]',
    className,
  );
  if (!animateIn) {
    return (
      <span aria-hidden className={cls} style={style}>
        {glyph}
      </span>
    );
  }
  return (
    <motion.span
      aria-hidden
      className={cls}
      style={style}
      initial={reduce ? false : { scale: 1.6, rotate: -14, opacity: 0 }}
      animate={{ scale: 1, rotate: bai ? -5 : 0, opacity: 1 }}
      transition={{ ...SPRING, delay: 0.2 + (index ?? 0) * 0.04 }}
    >
      {glyph}
    </motion.span>
  );
}
