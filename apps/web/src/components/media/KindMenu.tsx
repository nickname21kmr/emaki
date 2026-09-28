import { CONTENT_KINDS, type ContentKind } from '@emaki/shared';
import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui';
import { KIND_ICON, KIND_LABEL } from '@/lib/kinds';

/**
 * 「归入…」菜单（T32a）：插画加 6 个别册类型共 7 项，数字键 1–7 直接选；最后是「恢复自动判断」。
 * 图库多选（C）、看图器、未识别页共用。includeIllustration=false 时去掉插画（「不是插画」）。
 */
export function KindMenu({
  trigger,
  label,
  open,
  onOpenChange,
  onSelect,
  includeIllustration = true,
  current,
  align = 'center',
}: {
  trigger: ReactNode;
  label: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect: (kind: ContentKind | 'auto') => void;
  includeIllustration?: boolean;
  /** 当前类型：打勾（单张时用） */
  current?: ContentKind;
  align?: 'start' | 'center' | 'end';
}) {
  const kinds = includeIllustration ? CONTENT_KINDS : CONTENT_KINDS.filter((k) => k !== 'illustration');
  return (
    <Menu
      trigger={trigger}
      align={align}
      width={196}
      open={open}
      onOpenChange={onOpenChange}
      onKeyDown={(e) => {
        const n = Number(e.key);
        if (!Number.isInteger(n) || n < 1 || n > kinds.length || e.ctrlKey || e.metaKey || e.altKey) return;
        // 挡住全局的数字键跳页
        e.preventDefault();
        e.stopPropagation();
        onSelect(kinds[n - 1]!);
        onOpenChange?.(false);
      }}
    >
      <MenuLabel>{label}</MenuLabel>
      {kinds.map((k, i) => {
        const Icon = KIND_ICON[k];
        return (
          <MenuItem key={k} icon={<Icon />} shortcut={String(i + 1)} onSelect={() => onSelect(k)}>
            {KIND_LABEL[k]}
            {current === k && <span className="ml-1.5 text-[11px] text-fg-subtle">当前</span>}
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem icon={<RotateCcw />} onSelect={() => onSelect('auto')}>
        恢复自动判断
      </MenuItem>
    </Menu>
  );
}
