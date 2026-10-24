import { Ellipsis, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { useSonner } from 'sonner';
import { Kbd, Menu, MenuItem, RollingNumber, Spinner } from '@/components/ui';
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
  // 有 toast 时（底部居中）抬高一截给它让位，和图库的工具栏一样
  const lifted = useSonner().toasts.length > 0;
  // 菜单关掉、不还焦点以后再执行，接着打开的对话框不会被焦点抢走
  const afterMenu = useRef<(() => void) | null>(null);
  return (
    // assistant-cover-shift：助手附页覆盖在纸上时，在露出的那块里居中（index.css）
    <div className="assistant-cover-shift pointer-events-none sticky bottom-6 z-30 h-0 @container/bar">
      <AnimatePresence>
        {count > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: lifted ? -64 : 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            className="absolute inset-x-0 bottom-0 flex justify-center px-8 @max-[640px]/bar:px-3 @max-[360px]/bar:px-2"
          >
            <div
              role="toolbar"
              aria-label="已选插画的操作"
              // 露出的纸窄时（助手盖在纸上、半屏窗口）文字只留图标；再窄才在胶囊里横向滚，永远不伸出纸外
              className="pointer-events-auto flex h-12 max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-ink pr-1.5 pl-5 text-fg-inverse shadow-pop scrollbar-none *:shrink-0 @max-[640px]/bar:pl-3"
            >
              <div className="mr-2 flex items-baseline gap-1.5 text-[13px] whitespace-nowrap">
                <span className="text-fg-inverse/60 @max-[480px]/bar:hidden">已选</span>
                <RollingNumber value={count} appear={false} className="numeral text-[22px] leading-none" />
                <span className="text-fg-inverse/60 @max-[480px]/bar:hidden">张</span>
              </div>
              <span className="mx-1.5 h-5 w-px bg-fg-inverse/15" aria-hidden />
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={a.onClick}
                  title={a.label}
                  disabled={a.disabled || a.loading}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap',
                    'transition-[background-color,opacity] duration-150 hover:bg-fg-inverse/10 active:scale-[0.97]',
                    'disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
                    '@max-[360px]/bar:hidden',
                  )}
                >
                  {a.loading ? <Spinner className="size-4" /> : a.icon}
                  <span className="@max-[640px]/bar:sr-only">{a.label}</span>
                  {a.shortcut && (
                    <Kbd tone="inverse" className="ml-0.5 @max-[640px]/bar:hidden">
                      {a.shortcut}
                    </Kbd>
                  )}
                </button>
              ))}
              {/* 露出的纸窄于 360（助手覆盖在纸上）：操作都收进「更多」，平时藏着 */}
              {actions.length > 0 && (
                <Menu
                  align="end"
                  width={168}
                  onCloseAutoFocus={(e) => {
                    const next = afterMenu.current;
                    if (!next) return;
                    afterMenu.current = null;
                    e.preventDefault();
                    next();
                  }}
                  trigger={
                    <button
                      type="button"
                      aria-label="更多"
                      title="更多"
                      className="inline-flex h-9 items-center rounded-full px-3 transition-colors hover:bg-fg-inverse/10 data-[state=open]:bg-fg-inverse/10 @min-[360px]/bar:hidden [&_svg]:size-4"
                    >
                      {actions.some((a) => a.loading) ? <Spinner className="size-4" /> : <Ellipsis />}
                    </button>
                  }
                >
                  {actions.map((a) => (
                    <MenuItem key={a.key} icon={a.icon} shortcut={a.shortcut} disabled={a.disabled || a.loading} onSelect={() => { afterMenu.current = a.onClick; }}>
                      {a.label}
                    </MenuItem>
                  ))}
                </Menu>
              )}
              <span className="mx-1 h-5 w-px bg-fg-inverse/15" aria-hidden />
              <button
                type="button"
                onClick={onClear}
                aria-label="取消选择"
                className="inline-flex h-9 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-[13px] text-fg-inverse/70 transition-colors hover:bg-fg-inverse/10 hover:text-fg-inverse"
              >
                <Kbd tone="inverse" className="@max-[640px]/bar:hidden">Esc</Kbd>
                <X className="size-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
