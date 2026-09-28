import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Kbd, RollingNumber, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { EASE_OUT } from '@/lib/motion';

export interface SelectionAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** 右侧的快捷键提示 */
  shortcut?: string;
}

/**
 * 多选后浮起的墨色胶囊工具栏。
 *
 * 用 sticky（而不是 fixed）贴在滚动容器底部，这样它相对「纸」居中，而不是相对整个窗口。
 * 必须放在页面内容的最后面。
 */
export function SelectionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: SelectionAction[];
  onClear: () => void;
}) {
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
              aria-label="已选插画的操作"
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
                  disabled={a.disabled || a.loading}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap',
                    'transition-[background-color,opacity] duration-150 hover:bg-fg-inverse/10 active:scale-[0.97]',
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
              <span className="mx-1 h-5 w-px bg-fg-inverse/15" aria-hidden />
              <button
                type="button"
                onClick={onClear}
                aria-label="取消选择"
                className="inline-flex h-9 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-[13px] text-fg-inverse/70 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse"
              >
                <Kbd tone="inverse">Esc</Kbd>
                <X className="size-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
