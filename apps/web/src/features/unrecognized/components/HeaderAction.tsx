import { forwardRef } from 'react';
import { Button, Tooltip, type ButtonProps } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 未识别页头的操作按钮：三个按钮同一个样子（描边、md 高度、16px 图标），各带一句 tooltip 说清楚动的是哪些图。
 * forwardRef 并把其余属性透传给按钮，这样也能当菜单的触发器。
 */
export const HeaderAction = forwardRef<HTMLButtonElement, ButtonProps & { tip: string }>(function HeaderAction(
  { tip, ...rest },
  ref,
) {
  return (
    <Tooltip content={<span className="block max-w-64 leading-relaxed whitespace-normal">{tip}</span>}>
      {/* 手机竖屏（A1）矮一号，三个能排在一行 */}
      <Button ref={ref} variant="outline" {...rest} className={cn('compact:h-8 compact:gap-1.5 compact:px-2.5 compact:text-[12.5px]', rest.className)} />
    </Tooltip>
  );
});
