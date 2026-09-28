import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'shu' | 'ok' | 'warn' | 'danger' | 'glass' | 'ink';

const tones: Record<Tone, string> = {
  neutral: 'bg-sunken text-fg-muted',
  shu: 'bg-shu-soft text-shu-fg',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  ink: 'bg-ink text-fg-inverse',
  /** 叠在图片上用：毛玻璃 */
  glass: 'bg-black/35 text-white backdrop-blur-md ring-1 ring-white/15',
};

export function Badge({
  children,
  tone = 'neutral',
  dot,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  /** 左侧小圆点（例如「+N」角标前的绿点） */
  dot?: boolean | string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap tabular',
        tones[tone],
        className,
      )}
    >
      {dot && (
        <span
          className="size-1.5 rounded-full"
          style={{ background: typeof dot === 'string' ? dot : 'currentColor' }}
        />
      )}
      {children}
    </span>
  );
}

/** 侧边栏图标右上角的数字气泡 */
export function CountBubble({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-shu px-1 text-[10px] leading-none font-bold text-white tabular ring-2 ring-canvas',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
