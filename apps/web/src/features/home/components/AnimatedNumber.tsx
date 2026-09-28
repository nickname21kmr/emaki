import { RollingNumber } from '@/components/ui/RollingNumber';

/**
 * 已并入 RollingNumber（SEL-18）：首次出现 / 大跨度仍是连续补间，小变化改成逐位翻。
 * 保留这个名字只为兼容，新代码直接用 RollingNumber。
 */
export function AnimatedNumber({
  id,
  value,
  digits = 0,
  className,
}: {
  /** 用来记忆上次显示值的 key */
  id: string;
  value: number;
  digits?: 0 | 1;
  className?: string;
}) {
  return <RollingNumber id={id} value={value} digits={digits} size="xl" className={className} />;
}
