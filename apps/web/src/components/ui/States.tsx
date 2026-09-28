import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton rounded-md', className)} style={style} />;
}

/**
 * 空状态 / 错误状态。插画用大号斜体衬线字当「印章」，比通用图标更有性格。
 */
export function EmptyState({
  glyph = '空',
  icon,
  title,
  description,
  action,
  className,
}: {
  /** 一个汉字，作为大号装饰（默认「空」） */
  glyph?: string;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-20 text-center animate-rise', className)}>
      <div className="relative mb-6 flex size-24 items-center justify-center">
        <div className="absolute inset-0 rotate-6 rounded-[28px] bg-shu-soft" />
        <div className="absolute inset-0 -rotate-3 rounded-[28px] bg-raised shadow-lift ring-1 ring-line" />
        <span className="relative font-display text-5xl text-shu [&_svg]:size-9">{icon ?? glyph}</span>
      </div>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <EmptyState
      glyph="误"
      title="加载失败"
      description={message}
      action={
        onRetry && (
          <button onClick={onRetry} className="text-sm font-medium text-shu-fg underline-offset-4 hover:underline">
            重试
          </button>
        )
      }
    />
  );
}

/** 小节标题：「你最常看的  按收藏张数」 */
/**
 * 章节标题（画册语汇，T29b-3）：「01 衬线小标题 ——— 注释　操作」。
 * 编号由 CSS 计数器按 DOM 顺序自动生成（作用域在 AppShell 滚动容器的 chapter-scope 上），不要手写 01/02；
 * 某一段不渲染时后面的编号自动前移。组内小标题传 numbered={false}。
 */
export function SectionTitle({
  children,
  hint,
  actions,
  className,
  numbered = true,
}: {
  children: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  numbered?: boolean;
}) {
  return (
    // cn 不合并同类类名：调用方传了 mb-* 时就不加默认的 mb-4
    <div className={cn('mt-2 flex items-baseline gap-3', !/(^|s)mb-/.test(className ?? '') && 'mb-4', className)}>
      {numbered && <span aria-hidden className="chapter-no numeral shrink-0 text-[17px] text-shu tabular" />}
      <h2 className="font-serif-cjk text-[19px] font-semibold tracking-[.06em] whitespace-nowrap">{children}</h2>
      <span aria-hidden className="h-px min-w-6 flex-1 -translate-y-[5px] bg-rule" />
      {hint && <span className="shrink-0 whitespace-nowrap text-xs text-fg-subtle tabular">{hint}</span>}
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
