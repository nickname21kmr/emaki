import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Kbd, RollingNumber, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { EASE_OUT } from '@/lib/motion';

export interface BarAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  loading?: boolean;
  shortcut?: string;
}

/**
 * 多选后在底部浮起的墨色胶囊。
 * 用 sticky 贴在滚动容器（「纸」）底部，所以相对纸居中而不是相对整个窗口；要放在页面内容最后。
 */
export function SelectionBar({ count, actions }: { count: number; actions: BarAction[] }) {
  return (
    <div className="pointer-events-none sticky bottom-6 z-30 h-0">
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="absolute inset-x-0 bottom-0 flex justify-center px-8"
          >
            <div
              role="toolbar"
              aria-label="已选图片的操作"
              className="pointer-events-auto flex h-12 items-center gap-0.5 rounded-full bg-ink pr-1.5 pl-5 text-fg-inverse shadow-pop"
            >
              <div className="mr-2 flex items-baseline gap-1.5 text-[13px] whitespace-nowrap">
                <span className="text-fg-inverse/60">已选</span>
                <RollingNumber value={count} appear={false} className="numeral text-[22px] leading-none" />
                <span className="text-fg-inverse/60">张</span>
              </div>
              <span className="mx-1.5 h-5 w-px bg-fg-inverse/15" aria-hidden />
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={a.onClick}
                  disabled={a.loading}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap',
                    'transition-[background-color,opacity,scale] duration-150 hover:bg-fg-inverse/10 active:scale-[0.97]',
                    'disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
                  )}
                >
                  {a.loading ? <Spinner className="size-4" /> : a.icon}
                  {a.label}
                  {a.shortcut && (
                    <Kbd tone="inverse" className="ml-0.5">
                      {a.shortcut}
                    </Kbd>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
