import type { ReactNode } from 'react';
import { Switch } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 授权的一行（docs/plugins.md 4.2「一张授权单」）：设备的批准和权限（ScopePicker）、装插件的授权单（GrantRow）、
 * 插件详情里的授权（可以一项项关掉）都用这一种——一个圆点、一句话、下面一行小字说明；会动你的文件、整库批量改的朱色标出。
 * 有 onCheckedChange 的右边是开关（给 / 不给），关着的这一行淡一点
 */
export interface GrantItem {
  key: string;
  text: ReactNode;
  detail?: ReactNode;
  danger?: boolean;
  /** 有开关时：现在给没给 */
  checked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  /** 开关的读屏说法（不写用「给 / 不给：<text>」） */
  label?: string;
  /** 开关左边的按钮（文件夹的「换位置…」） */
  actions?: ReactNode;
  /** 一句话下面、说明上面的东西（选文件夹放在哪） */
  children?: ReactNode;
}

export function GrantItemRow({ item: i }: { item: GrantItem }) {
  const toggle = i.onCheckedChange;
  return (
    <li className={cn('flex gap-2.5', toggle && !i.checked && 'opacity-60')}>
      <span aria-hidden className={cn('mt-[9px] size-1 shrink-0 rounded-full', i.danger ? 'bg-danger' : 'bg-fg-subtle')} />
      <div className="min-w-0 flex-1">
        <span className={cn(i.danger && 'text-danger')}>{i.text}</span>
        {i.children}
        {i.detail && <span className="block text-[12px] text-fg-subtle">{i.detail}</span>}
      </div>
      {(i.actions || toggle) && (
        <div className="flex shrink-0 items-center gap-2 self-start">
          {i.actions}
          {toggle && (
            <Switch
              checked={!!i.checked}
              disabled={i.disabled}
              onCheckedChange={toggle}
              label={i.label ?? `${i.checked ? '不给' : '给'}：${typeof i.text === 'string' ? i.text : i.key}`}
            />
          )}
        </div>
      )}
    </li>
  );
}

export function GrantList({ items, className }: { items: readonly GrantItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2.5 text-[13px] leading-relaxed', className)}>
      {items.map((i) => (
        <GrantItemRow key={i.key} item={i} />
      ))}
    </ul>
  );
}
