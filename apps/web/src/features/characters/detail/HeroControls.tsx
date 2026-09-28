import { Check, Copy } from 'lucide-react';
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 叠在 Hero 图片上的毛玻璃图标按钮。
 * 不用 ui/IconButton 是因为它的配色是为「纸」设计的，放在暗化的图片上会看不清。
 */
export const GlassIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean }
>(function GlassIconButton({ label, shortcut, active, className, ...rest }, ref) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'inline-flex size-9 items-center justify-center rounded-full ring-1 backdrop-blur-md',
          'transition-[background-color,color,transform] duration-200 active:scale-[0.92] [&_svg]:size-[17px]',
          active
            ? 'bg-white text-shu ring-white/60 hover:bg-white/90'
            : 'bg-white/10 text-white ring-white/15 hover:bg-white/20',
          className,
        )}
        {...rest}
      />
    </Tooltip>
  );
});

/**
 * 可复制的 Danbooru 标签（等宽小字）。点一下复制，图标短暂变成对勾。
 * tone=glass 用在图片上，tone=paper 用在纸面上。
 */
export function CopyTag({ tag, tone = 'paper', className }: { tag: string; tone?: 'glass' | 'paper'; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tag);
      setCopied(true);
      toast.success('已复制 Danbooru 标签', { description: tag });
    } catch {
      toast.error('复制失败，浏览器不允许访问剪贴板');
    }
  };

  return (
    <Tooltip content={copied ? '已复制' : '复制标签'}>
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(
          'group/tag inline-flex h-7 max-w-full items-center gap-2 rounded-full pr-2.5 pl-3 font-mono text-[12px] transition-colors duration-200',
          tone === 'glass'
            ? 'bg-white/10 text-white/85 ring-1 ring-white/15 backdrop-blur-md hover:bg-white/20 hover:text-white'
            : 'bg-sunken text-fg-muted hover:bg-hover hover:text-fg',
          className,
        )}
      >
        <span className="truncate">{tag}</span>
        {copied ? (
          <Check className={cn('size-3.5 shrink-0', tone === 'glass' ? 'text-white' : 'text-ok')} />
        ) : (
          <Copy className="size-3.5 shrink-0 opacity-50 transition-opacity group-hover/tag:opacity-100" />
        )}
      </button>
    </Tooltip>
  );
}
