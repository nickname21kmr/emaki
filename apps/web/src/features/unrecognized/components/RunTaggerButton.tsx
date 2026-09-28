import { ScanSearch } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useTagJob } from '../useTagJob';

/**
 * 头部的「运行识别」。运行中按钮本身变成进度：转圈 + 百分比 + 底边一道朱色细线。
 */
export function RunTaggerButton({
  size = 'md',
  variant = 'secondary',
  label = '运行识别',
  className,
}: {
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
  label?: string;
  className?: string;
}) {
  const { running, progress, start } = useTagJob();

  if (running) {
    return (
      <div
        role="status"
        className={cn(
          'relative inline-flex shrink-0 items-center gap-2 overflow-hidden rounded-md bg-sunken font-medium text-fg-muted tabular',
          size === 'md' ? 'h-9 px-3.5 text-sm' : 'h-7 px-2.5 text-xs',
          className,
        )}
      >
        <Spinner className={size === 'md' ? 'size-4' : 'size-3.5'} />
        识别中{progress !== null && <span className="text-fg">{Math.round(progress * 100)}%</span>}
        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-line">
          <span
            className={cn(
              'block h-full bg-shu transition-[width] duration-300 ease-out',
              progress === null && 'w-1/3 animate-pulse',
            )}
            style={progress !== null ? { width: `${progress * 100}%` } : undefined}
          />
        </span>
      </div>
    );
  }

  return (
    <Button variant={variant} size={size} icon={<ScanSearch className="size-4" />} onClick={start} className={className}>
      {label}
    </Button>
  );
}
