import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Palette } from '@/lib/stores';

const OPTIONS: { value: Palette; label: string; hint: string }[] = [
  { value: 'washi', label: '米纸', hint: '默认，暖色画册纸' },
  { value: 'mono', label: '黑白', hint: '纯白 / 纯黑' },
  { value: 'mint', label: '薄荷', hint: '浅绿' },
  { value: 'sky', label: '天青', hint: '浅蓝' },
  { value: 'lilac', label: '雾紫', hint: '浅紫' },
];

/**
 * 底色选择：每个色板是一小块「纸」，左半浅色、右半深色，用对应底色的 token 渲染（data-palette 局部换肤）。
 */
export function PalettePicker({ value, onChange }: { value: Palette; onChange: (v: Palette) => void }) {
  return (
    <div role="radiogroup" aria-label="底色" className="flex flex-wrap gap-4">
      {OPTIONS.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className="group w-[88px] text-left"
          >
            <span
              className={cn(
                'relative flex h-[56px] overflow-hidden rounded-[12px] transition-[box-shadow,transform] duration-300 ease-[var(--ease-out-soft)]',
                selected
                  ? 'shadow-[0_0_0_2px_var(--c-raised),0_0_0_4px_var(--c-shu)]'
                  : 'shadow-[0_0_0_1px_var(--c-line-strong)] group-hover:-translate-y-0.5',
              )}
            >
              {(['light', 'dark'] as const).map((mode) => (
                <span key={mode} data-theme={mode} data-palette={o.value} className="flex flex-1 flex-col gap-[4px] bg-canvas p-[6px]">
                  <span className="flex-1 rounded-[5px] bg-sheet shadow-[0_0_0_1px_var(--c-line)]" />
                  <span className="h-[4px] w-2/3 rounded-full bg-fg/60" />
                </span>
              ))}
              {selected && (
                <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-shu text-white">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </span>
            <span className={cn('mt-2 block text-[13px]', selected ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg')}>{o.label}</span>
            <span className="block text-[11px] text-fg-subtle">{o.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
