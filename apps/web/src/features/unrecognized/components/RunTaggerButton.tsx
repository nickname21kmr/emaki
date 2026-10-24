import { ScanSearch } from 'lucide-react';
import { Button, Spinner, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useTagJob } from '../useTagJob';

/**
 * 「识别新图」：给还没识别过的图跑一遍 tagger。运行中按钮本身变成进度：转圈 + 百分比 + 底边一道朱色细线。
 * 页头用 outline + tip，和旁边两个按钮一组；面板里的「继续识别 N 张」等用 primary / secondary。
 */
export function RunTaggerButton({
  size = 'md',
  variant = 'secondary',
  label = '识别新图',
  tip,
  className,
}: {
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'outline';
  label?: string;
  /** 悬停说明（页头用） */
  tip?: string;
  className?: string;
}) {
  const { running, progress, start } = useTagJob();

  if (running) {
    return (
      <div
        role="status"
        className={cn(
          'relative inline-flex shrink-0 items-center gap-2 overflow-hidden rounded-md font-medium text-fg-muted tabular',
          variant === 'outline' ? 'border border-line-strong' : 'bg-sunken',
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

  const button = (
    <Button variant={variant} size={size} icon={<ScanSearch />} onClick={start} className={className}>
      {label}
    </Button>
  );
  return tip ? <Tooltip content={<span className="block max-w-64 leading-relaxed whitespace-normal">{tip}</span>}>{button}</Tooltip> : button;
}
