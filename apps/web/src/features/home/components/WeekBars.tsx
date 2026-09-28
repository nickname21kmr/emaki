import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { dayLabel, EASE_OUT_SOFT } from '../utils';

/** 柱子生长动画每次打开应用只播一次，来回切页面不重复 */
let played = false;

/**
 * 近 7 天新增的迷你柱状图（纯 CSS）。今天那根用朱色，其余是淡墨。
 * days：从旧到新，最后一个是今天。
 */
export function WeekBars({ days }: { days: readonly number[] }) {
  const reduce = useReducedMotion();
  const [animateIn] = useState(() => !played && !reduce);
  useEffect(() => {
    played = true;
  }, []);

  const max = Math.max(1, ...days);
  const last = days.length - 1;

  return (
    // 柱子底边和数字基线对齐，「近 7 天」悬在下面，不撑高这一行
    <div className="relative shrink-0">
      <div className="flex h-11 items-end gap-[5px]" role="img" aria-label="近 7 天每天新增的张数">
        {days.map((n, i) => {
          const back = last - i;
          const isToday = back === 0;
          // 0 张也留一道细线，让「没有新收」的日子可见
          const height = n === 0 ? 2 : `${Math.max(10, (n / max) * 100)}%`;
          return (
            <Tooltip
              key={i}
              side="top"
              content={`${dayLabel(back)} · ${n ? `新收 ${formatCount(n)} 张` : '没有新收'}`}
            >
              <div className="group/bar flex h-full w-[7px] items-end">
                <motion.div
                  className={cn(
                    'w-full origin-bottom rounded-[2px] transition-[height,background-color] duration-300',
                    isToday ? 'bg-shu' : 'bg-line-strong group-hover/bar:bg-fg-subtle',
                  )}
                  style={{ height }}
                  initial={animateIn ? { scaleY: 0 } : false}
                  animate={{ scaleY: 1 }}
                  transition={{ delay: 0.2 + i * 0.05, duration: 0.7, ease: EASE_OUT_SOFT }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      <span className="absolute top-full right-0 mt-2 text-[10.5px] leading-none whitespace-nowrap text-fg-subtle">
        近 7 天
      </span>
    </div>
  );
}
