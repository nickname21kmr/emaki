import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'shu' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-fg-inverse hover:bg-ink-hover shadow-[0_1px_0_rgb(255_255_255/0.08)_inset]',
  secondary: 'bg-sunken text-fg hover:bg-hover hover:brightness-[0.98]',
  ghost: 'text-fg-muted hover:text-fg hover:bg-hover',
  outline: 'text-fg border border-line-strong hover:bg-hover',
  shu: 'bg-shu text-white hover:brightness-110 shadow-[0_6px_20px_-8px_var(--c-shu)]',
  danger: 'bg-danger-soft text-danger hover:bg-danger hover:text-white',
};

const sizes: Record<Size, string> = {
  // 图标尺寸跟着按钮走：lucide 默认 24px，不约束的话按钮会被撑大
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-sm [&_svg]:size-3.5',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md [&_svg]:size-4',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-md [&_svg]:size-[18px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** 右侧附加（快捷键提示等） */
  trailing?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none [&_svg]:shrink-0',
        'transition-[background-color,color,filter,scale,box-shadow] duration-150 active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：无障碍标签 + tooltip 文案 */
  label: string;
  /** tooltip 里显示的快捷键 */
  shortcut?: string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}

const iconSizes: Record<Size, string> = {
  sm: 'size-7 rounded-sm [&_svg]:size-3.5',
  md: 'size-9 rounded-md [&_svg]:size-[18px]',
  lg: 'size-11 rounded-md [&_svg]:size-5',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, variant = 'ghost', size = 'md', active, className, tooltipSide = 'bottom', ...rest },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'inline-flex shrink-0 items-center justify-center transition-[background-color,color,scale] duration-150 active:scale-[0.92]',
          'disabled:pointer-events-none disabled:opacity-40',
          variants[variant],
          iconSizes[size],
          active && 'bg-shu-soft text-shu-fg hover:bg-shu-soft hover:text-shu-fg',
          className,
        )}
        {...rest}
      />
    </Tooltip>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
