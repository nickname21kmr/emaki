import { Slider as S, Switch as Sw } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Sw.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200',
        'bg-line-strong data-[state=checked]:bg-shu disabled:opacity-40',
      )}
    >
      <Sw.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-[var(--ease-spring)] data-[state=checked]:translate-x-[18px]" />
    </Sw.Root>
  );
}

export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 100,
  step = 1,
  label,
  className,
}: {
  value: number;
  onValueChange: (v: number) => void;
  /** 松手（或键盘调整结束）时触发，适合在这里保存 */
  onValueCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  className?: string;
}) {
  return (
    <S.Root
      value={[value]}
      onValueChange={(v) => onValueChange(v[0] ?? value)}
      onValueCommit={onValueCommit ? (v) => onValueCommit(v[0] ?? value) : undefined}
      min={min}
      max={max}
      step={step}
      aria-label={label}
      className={cn('relative flex h-5 w-full touch-none items-center select-none', className)}
    >
      <S.Track className="relative h-1 grow overflow-hidden rounded-full bg-line-strong">
        <S.Range className="absolute h-full rounded-full bg-ink" />
      </S.Track>
      <S.Thumb className="block size-4 rounded-full bg-raised shadow-[0_0_0_1px_var(--c-line-strong),0_2px_6px_rgb(0_0_0/0.18)] transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-shu" />
    </S.Root>
  );
}

export function Progress({
  value,
  className,
  tone = 'ink',
  glint,
}: {
  value: number | null;
  className?: string;
  tone?: 'ink' | 'shu' | 'ok';
  /** 填充段上一道一直在走的扫光（SEL-19）：长任务里表示「还在干活」 */
  glint?: boolean;
}) {
  const color = tone === 'shu' ? 'bg-shu' : tone === 'ok' ? 'bg-ok' : 'bg-ink';
  return (
    <div className={cn('relative h-1 w-full overflow-hidden rounded-full bg-line', className)}>
      {value === null ? (
        <div className={cn('absolute inset-y-0 w-1/3 animate-indeterminate rounded-full', color)} />
      ) : (
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', color, glint && 'glint')}
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        />
      )}
    </div>
  );
}

/** 设置页里的一行：左边标题说明，右边控件 */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-3.5', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
