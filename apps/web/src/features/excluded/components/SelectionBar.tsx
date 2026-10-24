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
    // assistant-cover-shift：助手附页覆盖在纸上时，在露出的那块里居中（index.css）
    <div className="assistant-cover-shift pointer-events-none sticky bottom-6 z-30 h-0 @container/bar">
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="absolute inset-x-0 bottom-0 flex justify-center px-8 @max-[520px]/bar:px-2"
          >
            <div
              role="toolbar"
              aria-label="已选图片的操作"
              // 露出的纸窄时（助手盖在纸上）文字只给读屏，只留图标
              className="pointer-events-auto flex h-12 items-center gap-0.5 rounded-full bg-ink pr-1.5 pl-5 text-fg-inverse shadow-pop *:shrink-0 @max-[520px]/bar:pl-3"
            >
              <div className="mr-2 flex items-baseline gap-1.5 text-[13px] whitespace-nowrap">
                <span className="text-fg-inverse/60 @max-[400px]/bar:hidden">已选</span>
                <RollingNumber value={count} appear={false} className="numeral text-[22px] leading-none" />
                <span className="text-fg-inverse/60 @max-[400px]/bar:hidden">张</span>
              </div>
              <span className="mx-1.5 h-5 w-px bg-fg-inverse/15 @max-[190px]/bar:hidden" aria-hidden />
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  title={a.label}
                  onClick={a.onClick}
                  disabled={a.loading}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] @max-[190px]/bar:px-2 font-medium whitespace-nowrap',
                    'transition-[background-color,opacity,scale] duration-150 hover:bg-fg-inverse/10 active:scale-[0.97]',
                    'disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
                  )}
                >
                  {a.loading ? <Spinner className="size-4" /> : a.icon}
                  <span className="@max-[520px]/bar:sr-only">{a.label}</span>
                  {a.shortcut && (
                    <Kbd tone="inverse" className="ml-0.5 @max-[520px]/bar:hidden">
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
