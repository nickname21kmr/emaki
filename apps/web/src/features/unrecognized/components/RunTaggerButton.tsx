import { ScanSearch, X } from 'lucide-react';
import { Button, Spinner, Tooltip } from '@/components/ui';
import { useCancelJob } from '@/features/settings/hooks';
import { useJobResultToast } from '@/features/settings/useJobResultToast';
import { useCan } from '@/lib/capabilities';
import { cn } from '@/lib/cn';
import { useTagJob } from '../useTagJob';

/**
 * 「识别新图」：给还没识别过的图跑一遍 tagger。运行中按钮本身变成进度：转圈 + 百分比 + 底边一道朱色细线，右端一个小叉可以原地停止。
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
  const { job, running, progress, start } = useTagJob();
  // 启动、停止任务要 jobs（lib/capabilities.ts）：没有的设备上只看进度，不给按钮
  const canRun = useCan('jobs');
  // 从这个按钮点的启动，任务结束时把结果弹出来：没有可识别的图时几秒就结束，以前按钮悄悄变回原样，像没反应。
  // 同一页挂着两三个「识别新图」，各记各的，只有点的那个弹
  const arm = useJobResultToast('tag');
  const cancel = useCancelJob();

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
        {/* 原地停止（已经识别的结果留着），不用跑去首页横幅或设置页。任务还没登记上（刚点下去）时先不画 */}
        {canRun && job && (
          <Tooltip content="停止识别">
            <button
              type="button"
              aria-label="停止识别"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(job.id)}
              className={cn(
                // 贴着右端、和进度条一样高；焦点框画在里面（画在外面会被进度条的圆角裁掉）
                'flex shrink-0 items-center justify-center self-stretch text-fg-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-40',
                size === 'md' ? '-mr-3.5 -ml-1 w-8 [&_svg]:size-3.5' : '-mr-2.5 -ml-1 w-7 [&_svg]:size-3',
              )}
            >
              <X />
            </button>
          </Tooltip>
        )}
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

  if (!canRun) return null;
  const button = (
    <Button
      variant={variant}
      size={size}
      icon={<ScanSearch />}
      onClick={() => {
        arm();
        start();
      }}
      className={className}
    >
      {label}
    </Button>
  );
  return tip ? <Tooltip content={<span className="block max-w-64 leading-relaxed whitespace-normal">{tip}</span>}>{button}</Tooltip> : button;
}
