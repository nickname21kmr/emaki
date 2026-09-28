import type { ContentKind } from '@emaki/shared';
import { Seal } from '@/components/ui';
import { cn } from '@/lib/cn';
import { KIND_GLYPH, KIND_LABEL } from '@/lib/kinds';

/**
 * 缩略图上的类型朱文小印（T32b，SEL-5）：只给非插画显示，放左下角
 * （RV-A-13：选择圈左上、模糊角标右上、收藏右下）。在「全部」视图里开，图库默认视图和别册里不开。
 */
export function KindBadge({ kind, className }: { kind: ContentKind; className?: string }) {
  if (kind === 'illustration') return null;
  return (
    <span title={KIND_LABEL[kind]} className={cn('pointer-events-none absolute bottom-1.5 left-1.5 flex', className)}>
      <Seal variant="zhu" size={16} glyph={KIND_GLYPH[kind]} />
    </span>
  );
}
