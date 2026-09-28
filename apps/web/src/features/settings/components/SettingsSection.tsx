import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SECTIONS, sectionDomId, sectionNumber, type SectionId } from '../sections';

/**
 * 设置的一节：斜体编号 + 标题 + 一句说明，右边放本节的操作；下面是卡片。
 * 编号与左侧目录一一对应，像书的章节号，方便扫读。
 */
export function SettingsSection({
  id,
  description,
  actions,
  children,
}: {
  id: SectionId;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const index = SECTIONS.findIndex((s) => s.id === id);
  const domId = sectionDomId(id);
  return (
    <section id={domId} aria-labelledby={`${domId}-title`} className="scroll-mt-8">
      <header className="mb-4 flex items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span aria-hidden className="numeral w-8 shrink-0 text-[28px] text-fg-subtle tabular">
              {sectionNumber(index)}
            </span>
            <h2 id={`${domId}-title`} className="text-[17px] font-semibold tracking-tight">
              {SECTIONS[index]?.title}
            </h2>
          </div>
          {/* 说明和标题左对齐（跳过编号列：w-8 + gap-3） */}
          {description && <p className="mt-1.5 pl-11 text-[13px] leading-relaxed text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** 一张设置卡片：行与行之间细线分隔，不加阴影，靠描边立起来 */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-line rounded-xl bg-raised px-5 ring-1 ring-line', className)}>{children}</div>
  );
}

/** 通栏行：标题说明在上，控件在下（主题卡片、阈值示意这类宽内容） */
export function BlockRow({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-4">
      {label && <div className="text-sm font-medium">{label}</div>}
      {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{hint}</div>}
      <div className={cn(label || hint ? 'mt-4' : undefined)}>{children}</div>
    </div>
  );
}
