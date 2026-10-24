import { Check, ChevronRight } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * 下拉菜单。
 *   <Menu trigger={<Button>排序</Button>}>
 *     <MenuLabel>排序方式</MenuLabel>
 *     <MenuItem icon={<Clock/>} onSelect={…}>最近添加</MenuItem>
 *     <MenuCheckboxItem checked={…} onCheckedChange={…}>只看收藏</MenuCheckboxItem>
 *     <MenuSeparator />
 *   </Menu>
 */
export function Menu({
  trigger,
  children,
  align = 'end',
  width = 220,
  maxWidth,
  open,
  onOpenChange,
  onKeyDown,
  onCloseAutoFocus,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /** 最小宽度；内容更宽时菜单跟着变宽 */
  width?: number;
  /** 最大宽度（例如长标题要截断的会话列表） */
  maxWidth?: number;
  /** 受控打开（例如用快捷键打开）；不传就由触发按钮控制 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 菜单打开时的按键（例如数字键直接选）；调用 e.stopPropagation() 可以挡住全局快捷键 */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** 菜单关闭、焦点还给触发按钮之前；e.preventDefault() 可以不还焦点（例如接着打开弹窗） */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <M.Root open={open} onOpenChange={onOpenChange}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={6} style={{ minWidth: width, maxWidth }} className={contentClass} onKeyDown={onKeyDown} onCloseAutoFocus={onCloseAutoFocus}>
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

const contentClass = cn(
  'z-[60] max-h-[min(480px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto rounded-lg bg-raised p-1.5 shadow-pop ring-1 ring-line scrollbar-thin',
  'origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-rise',
);

const itemClass = cn(
  'relative flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2.5 text-[13px] text-fg outline-none select-none',
  'data-[highlighted]:bg-hover data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:text-fg-muted',
);

export function MenuItem({
  children,
  icon,
  shortcut,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(itemClass, danger && 'text-danger [&_svg]:text-danger data-[highlighted]:bg-danger-soft')}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-fg-subtle">{shortcut}</span>}
    </M.Item>
  );
}

/** 只有图标的小菜单项，放在一行的右边（例如会话后面的删除）。方向键能走到，aria-label 必填 */
export function MenuIconItem({
  label,
  children,
  onSelect,
  disabled,
  className,
}: {
  label: string;
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <M.Item
      aria-label={label}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex size-8 shrink-0 cursor-default items-center justify-center rounded-sm text-fg-subtle outline-none select-none',
        'data-[highlighted]:bg-hover data-[highlighted]:text-fg data-[disabled]:opacity-40 [&_svg]:size-3.5',
        className,
      )}
    >
      {children}
    </M.Item>
  );
}

export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <M.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      className={cn(itemClass, 'pr-8')}
    >
      <span className="flex-1">{children}</span>
      <M.ItemIndicator className="absolute right-2.5">
        <Check className="!text-shu" />
      </M.ItemIndicator>
    </M.CheckboxItem>
  );
}

export function MenuRadioGroup<T extends string>({
  value,
  onValueChange,
  children,
}: {
  value: T;
  onValueChange: (v: T) => void;
  children: ReactNode;
}) {
  return (
    <M.RadioGroup value={value} onValueChange={(v) => onValueChange(v as T)}>
      {children}
    </M.RadioGroup>
  );
}

export function MenuRadioItem({ value, children, icon }: { value: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <M.RadioItem value={value} className={cn(itemClass, 'pr-8')}>
      {icon}
      {/* min-w-0：菜单限了 maxWidth 时，里面的 truncate 才截得住 */}
      <span className="min-w-0 flex-1">{children}</span>
      <M.ItemIndicator className="absolute right-2.5">
        <Check className="!text-shu" />
      </M.ItemIndicator>
    </M.RadioItem>
  );
}

export function MenuSub({ label, icon, children }: { label: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <M.Sub>
      <M.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-hover')}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="!size-3.5" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent sideOffset={6} className={cn(contentClass, 'min-w-[200px]')}>
          {children}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="-mx-1.5 my-1.5 h-px bg-line" />;
}
