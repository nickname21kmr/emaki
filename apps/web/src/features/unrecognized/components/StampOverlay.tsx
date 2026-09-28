import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import type { StampEvent } from '../types';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;

/**
 * 采纳 / 排除后在预览中央「盖一下印」：朱色方印 + 下面一枚墨色小签。
 * 只停留不到一秒，不挡操作（pointer-events-none），连按也只会一枚接一枚地换。
 */
export function StampOverlay({ stamp }: { stamp: StampEvent | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <AnimatePresence>
        {stamp && (
          <motion.div
            key={stamp.key}
            initial={{ opacity: 0, scale: 1.45, rotate: -14 }}
            animate={{ opacity: 1, scale: 1, rotate: -7, transition: { duration: 0.22, ease: EASE } }}
            exit={{ opacity: 0, scale: 0.96, y: -12, transition: { duration: 0.32, ease: EASE } }}
            className="flex flex-col items-center gap-3"
          >
            <div
              className={cn(
                'flex size-[92px] items-center justify-center rounded-[20px] border-[3px] bg-sheet/85 font-display text-[52px] leading-none backdrop-blur-md',
                stamp.tone === 'shu' ? 'border-shu text-shu' : 'border-fg-muted text-fg-muted',
              )}
              // 内圈再描一道细线，像篆刻印章的双边框
              style={{ boxShadow: 'inset 0 0 0 3px var(--c-sheet), inset 0 0 0 4.5px currentColor' }}
            >
              {stamp.glyph}
            </div>
            <div className="max-w-[280px] truncate rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-fg-inverse">
              {stamp.label}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
