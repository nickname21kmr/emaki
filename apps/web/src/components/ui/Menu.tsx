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
  open,
  onOpenChange,
  onKeyDown,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  width?: number;
  /** 受控打开（例如用快捷键打开）；不传就由触发按钮控制 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 菜单打开时的按键（例如数字键直接选）；调用 e.stopPropagation() 可以挡住全局快捷键 */
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <M.Root open={open} onOpenChange={onOpenChange}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={6} style={{ minWidth: width }} className={contentClass} onKeyDown={onKeyDown}>
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
      <span className="flex-1">{children}</span>
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
