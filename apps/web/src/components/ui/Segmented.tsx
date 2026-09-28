import { motion } from 'motion/react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/**
 * 分段切换（「书架 / 列表」）。选中块用 motion 的 layoutId 平滑滑动。
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-disabled={disabled || undefined}
      className={cn(
        'inline-flex items-center rounded-full bg-sunken p-0.5',
        size === 'md' ? 'h-8' : 'h-7',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative inline-flex h-full items-center gap-1.5 rounded-full font-medium transition-colors duration-200',
              size === 'md' ? 'px-3.5 text-[13px]' : 'px-2.5 text-xs',
              active ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-full bg-raised shadow-card ring-1 ring-line"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5 [&_svg]:size-3.5">
              {opt.icon}
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
