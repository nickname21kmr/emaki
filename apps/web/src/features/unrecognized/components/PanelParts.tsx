import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Kbd, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';

/** 决策面板里的小节：一行小标题 + 右侧提示 */
export function PanelSection({
  title,
  hint,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mt-7', className)}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[12.5px] font-semibold tracking-tight text-fg-muted">{title}</h3>
        {hint && <span className="text-[11px] text-fg-subtle">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * 一条建议 = 一行大按钮：左边斜体衬线编号（也就是快捷键），中间角色 / 作品，
 * 右边置信度；卡片底边是一道朱色的置信度条。
 * 传了 onToggleCheck 时右端多一个勾选框：点行 = 直接采纳，点勾选框 = 先记下、稍后一起采纳（issue #5）。
 */
export function SuggestionRow({
  n,
  name,
  workName,
  value,
  valueLabel,
  valueUnit,
  isNew,
  sourceLabel,
  title,
  onPick,
  checked,
  onToggleCheck,
}: {
  n: number;
  name: string;
  workName: string | null;
  /** 0~1，决定底边进度条长度 */
  value: number;
  /** 右侧大字，例如 54 或 8/12 */
  valueLabel: ReactNode;
  valueUnit?: ReactNode;
  /** 库里还没有这个角色，采纳时会新建 */
  isNew?: boolean;
  sourceLabel?: string;
  title?: string;
  onPick: () => void;
  checked?: boolean;
  onToggleCheck?: () => void;
}) {
  const row = (
    <button
      type="button"
      onClick={onPick}
      title={title}
      className={cn(
        'group relative flex w-full items-center gap-3.5 overflow-hidden rounded-[14px] bg-raised py-3 pr-4 pl-3.5 text-left',
        'shadow-[0_0_0_1px_var(--c-line)] transition-[box-shadow,transform] duration-200 ease-[var(--ease-out-soft)]',
        'hover:shadow-[0_0_0_1px_var(--c-line-strong),var(--shadow-card)] active:scale-[0.99]',
        onToggleCheck && 'pr-12',
        checked && 'shadow-[0_0_0_1.5px_var(--c-shu)] hover:shadow-[0_0_0_1.5px_var(--c-shu),var(--shadow-card)]',
      )}
    >
      <span className="numeral w-6 shrink-0 text-center text-[32px] text-fg-subtle transition-colors duration-200 group-hover:text-shu">
        {n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold tracking-tight">{name}</span>
          {isNew && <Badge className="shrink-0">新角色</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-fg-muted">{workName ?? '未知作品'}</span>
      </span>
      {sourceLabel && <span className="shrink-0 text-[11px] text-fg-muted">{sourceLabel}</span>}
      {valueLabel != null && <span className="shrink-0 text-right leading-none tabular">
        <span className="text-[17px] font-semibold tracking-tight">{valueLabel}</span>
        {valueUnit && <span className="ml-0.5 text-[11px] text-fg-muted">{valueUnit}</span>}
      </span>}
      {valueLabel != null && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-line" aria-hidden>
        <span
          className="block h-full rounded-r-full bg-shu transition-[width] duration-500 ease-[var(--ease-out-soft)]"
          style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        />
      </span>}
    </button>
  );
  if (!onToggleCheck) return row;
  return (
    <div className="relative">
      {row}
      {/* 勾选框是行旁边的独立按钮（不能套在行按钮里），压在卡片右端 */}
      <Tooltip content="勾选，稍后一起采纳" shortcut={`⇧${n}`} side="left">
        <button
          type="button"
          role="checkbox"
          aria-checked={!!checked}
          aria-label={`勾选：${name}`}
          data-suggestion-check
          onClick={onToggleCheck}
          className={cn(
            'absolute top-1/2 right-3 flex size-6 -translate-y-1/2 items-center justify-center rounded-[7px] transition-[background-color,box-shadow,color] duration-150',
            checked
              ? 'bg-shu text-white shadow-none'
              : 'bg-raised text-transparent shadow-[0_0_0_1px_var(--c-line-strong)] hover:text-fg-subtle hover:shadow-[0_0_0_1px_var(--c-fg-subtle)]',
          )}
        >
          <Check className="size-3.5" strokeWidth={3} />
        </button>
      </Tooltip>
    </div>
  );
}

/** 底部操作键：图标 + 文字 + 快捷键，竖排的小方块 */
export function ActionKey({
  icon,
  label,
  keys,
  onClick,
  tone = 'default',
  disabled,
}: {
  icon: ReactNode;
  label: string;
  keys: string[];
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex h-[62px] flex-col items-center justify-center gap-1.5 rounded-[12px] bg-sunken text-[12.5px] font-medium text-fg',
        'transition-[background-color,color,transform] duration-150 hover:bg-hover active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        tone === 'danger' && 'hover:bg-danger-soft hover:text-danger',
      )}
    >
      <span className="flex items-center gap-1.5 [&_svg]:size-4 [&_svg]:text-fg-muted group-hover:[&_svg]:text-current">
        {icon}
        {label}
      </span>
      <span className="flex items-center gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </button>
  );
}
