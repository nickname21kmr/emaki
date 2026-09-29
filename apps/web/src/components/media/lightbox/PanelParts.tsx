import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

/** 信息面板里的一个分组：细线分隔 + 小号灰色标题 */
export function Section({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-t border-line px-5 py-4', className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-fg-subtle">{title}</h3>
        {meta && <span className="text-[11px] text-fg-subtle tabular">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** 面板顶部的一排操作：图标 + 短标签 */
export function ActionTile({
  icon,
  label,
  tooltip,
  shortcut,
  active,
  danger,
  pending,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tooltip?: string;
  shortcut?: string;
  active?: boolean;
  danger?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={tooltip ?? label} shortcut={shortcut}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        aria-pressed={active}
        className={cn(
          'flex flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11.5px] font-medium transition-[background-color,color,transform] duration-150',
          'active:scale-[0.95] disabled:opacity-50 [&_svg]:size-[18px] [&_svg]:transition-transform [&_svg]:duration-300',
          active
            ? 'bg-shu-soft text-shu-fg [&_svg]:scale-110 [&_svg]:fill-current'
            : danger
              ? 'text-fg-muted hover:bg-danger-soft hover:text-danger'
              : 'text-fg-muted hover:bg-hover hover:text-fg',
        )}
      >
        {icon}
        {label}
      </button>
    </Tooltip>
  );
}
