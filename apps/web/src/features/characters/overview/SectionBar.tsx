import type { CharacterSort } from '@emaki/shared';
import { ArrowDownWideNarrow, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { Button, Kbd, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { SORT_OPTIONS } from './params';

/**
 * 「全部角色」的小节标题条。滚过去以后吸在页头下面（--page-head-h）：不透明的纸 + 一道细线，
 * 长书架往下翻时排序和新建始终够得着。below 用来放列表视图的列标题。
 */
export function SectionBar({
  title,
  hint,
  actions,
  below,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  below?: ReactNode;
}) {
  const scrollRef = useScrollContainer();
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  // 页头也吸顶：用滚动监听比较哨兵和「页头下沿」，吸在页头下面（RV-A-5）
  useEffect(() => {
    const sc = scrollRef.current;
    const el = sentinel.current;
    if (!sc || !el) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const off = parseFloat(getComputedStyle(sc).getPropertyValue('--page-head-h')) || 0;
      setStuck(el.getBoundingClientRect().top < sc.getBoundingClientRect().top + off);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    sc.addEventListener('scroll', on, { passive: true });
    return () => {
      sc.removeEventListener('scroll', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  return (
    <>
      <div ref={sentinel} aria-hidden className="h-px" />
      <div
        className={cn('sticky top-[var(--page-head-h,0px)] z-10 -mx-8 mb-3 px-8', stuck && 'bg-sheet paper shadow-[0_1px_0_var(--c-line)]')}
      >
        <div className="flex h-14 items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <span aria-hidden className="chapter-no numeral shrink-0 text-[17px] text-shu tabular" />
            <h2 className="truncate font-serif-cjk text-[19px] font-semibold tracking-[.06em]">{title}</h2>
            <span aria-hidden className="h-px min-w-6 flex-1 -translate-y-[5px] bg-rule" />
            {hint && <span className="shrink-0 whitespace-nowrap text-xs text-fg-subtle tabular">{hint}</span>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
        {below}
      </div>
    </>
  );
}

export function SortMenu({ value, onChange }: { value: CharacterSort; onChange: (v: CharacterSort) => void }) {
  const label = SORT_OPTIONS.find((o) => o.value === value)?.label ?? '排序';
  return (
    <Menu
      width={168}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowDownWideNarrow className="size-3.5" />}
          trailing={<ChevronDown className="size-3 opacity-60" />}
        >
          {label}
        </Button>
      }
    >
      <MenuLabel>排序方式</MenuLabel>
      <MenuRadioGroup value={value} onValueChange={onChange}>
        {SORT_OPTIONS.map((o) => (
          <MenuRadioItem key={o.value} value={o.value}>
            {o.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

export function NewCharacterButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} trailing={<Kbd className="ml-0.5">N</Kbd>} onClick={onClick}>
      新建角色
    </Button>
  );
}

/** 列表到底：一句安静的收尾，而不是突然断掉 */
export function EndMark({ total, label }: { total?: number; label?: string }) {
  return (
    <div className="flex items-center gap-4 pt-12 pb-4 text-[11px] text-fg-subtle">
      <span className="h-px flex-1 bg-line" />
      <span className="tabular">{label ?? (total !== undefined ? `共 ${formatCount(total)} 位 · 到底了` : '到底了')}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
