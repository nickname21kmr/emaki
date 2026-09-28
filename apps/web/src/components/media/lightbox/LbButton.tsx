import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 看图器深色背景上的圆形图标按钮。
 * 看图器不论亮 / 暗主题都是深色底，所以这里用白色半透明，而不是语义 token。
 */
export const LbButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    shortcut?: string;
    active?: boolean;
    tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  }
>(function LbButton({ label, shortcut, active, tooltipSide = 'bottom', className, ...rest }, ref) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full text-white/70 transition-[background-color,color,transform] duration-150',
          'hover:bg-white/12 hover:text-white active:scale-[0.92] disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-[18px]',
          active && 'bg-white/14 text-white',
          className,
        )}
        {...rest}
      />
    </Tooltip>
  );
});
