import type { FocusPoint, ID, Rating } from '@emaki/shared';
import { cn } from '@/lib/cn';
import { Thumb } from './Thumb';

/** 扇形里的一张封面 */
export interface FanCover {
  imageId: ID;
  rating: Rating;
  color?: string | null;
  focus?: FocusPoint | null;
}

/*
 * 全站唯一的扇形叠放（MG-8）：参考图的作品卡——中间一张正放，两侧更小、向外转、被遮住一部分，
 * 底下一道柔和投影；悬停（或键盘聚焦）时微微展开。
 *
 * 纯 CSS：外层（Link / button）加 `group/fan` 类，这里用 group-hover/fan、group-focus-visible/fan 触发，
 * 上百张卡不需要每张挂 JS。几何全用百分比，尺寸由外层宽度决定。
 * motion-safe: 前缀保证系统开了「减少动态效果」时只加深阴影、不改几何。
 * 类名必须写成完整字面量，Tailwind 才扫描得到。
 */

const CARD =
  'absolute overflow-hidden rounded-[var(--radius-plate)] bg-sunken ring-[3px] ring-raised ' +
  'transition-[translate,rotate,scale,box-shadow] duration-[520ms] ease-[var(--ease-fan)]';

/** 3 张：盒子 6:5，卡宽 54%（OV-2）；侧卡外移 45%（原 34%，第二轮反馈：作品之间空太多，把扇面铺宽） */
const BOX_3 = 'aspect-[6/5]';
const CARD_3 = 'top-[6%] left-[23%] aspect-[3/4] w-[54%]';
const SLOTS_3: string[] = [
  // 中间
  'z-[3] shadow-[var(--shadow-fan)] motion-safe:group-hover/fan:-translate-y-[4%] motion-safe:group-hover/fan:scale-103 group-hover/fan:shadow-[var(--shadow-fan-hover)] motion-safe:group-focus-visible/fan:-translate-y-[4%] motion-safe:group-focus-visible/fan:scale-103 group-focus-visible/fan:shadow-[var(--shadow-fan-hover)]',
  // 左
  'z-[1] -translate-x-[45%] -rotate-5 scale-88 shadow-[var(--shadow-card)] motion-safe:group-hover/fan:-translate-x-[58%] motion-safe:group-hover/fan:translate-y-[2%] motion-safe:group-hover/fan:-rotate-9 motion-safe:group-hover/fan:scale-90 motion-safe:group-focus-visible/fan:-translate-x-[58%] motion-safe:group-focus-visible/fan:translate-y-[2%] motion-safe:group-focus-visible/fan:-rotate-9 motion-safe:group-focus-visible/fan:scale-90',
  // 右
  'z-[2] translate-x-[45%] rotate-5 scale-88 shadow-[var(--shadow-card)] motion-safe:group-hover/fan:translate-x-[58%] motion-safe:group-hover/fan:translate-y-[2%] motion-safe:group-hover/fan:rotate-9 motion-safe:group-hover/fan:scale-90 motion-safe:group-focus-visible/fan:translate-x-[58%] motion-safe:group-focus-visible/fan:translate-y-[2%] motion-safe:group-focus-visible/fan:rotate-9 motion-safe:group-focus-visible/fan:scale-90',
];

/** 5 张：盒子 11:5，卡宽 29%，底部为轴心（HO-11 的 lg 版换算成百分比） */
const BOX_5 = 'aspect-[11/5]';
const CARD_5 = 'top-[7%] left-[35.5%] aspect-[3/4] w-[29%] origin-[50%_90%]';
const SLOTS_5: string[] = [
  // 中间
  'z-[3] shadow-[var(--shadow-fan)] -translate-y-[1%] motion-safe:group-hover/fan:-translate-y-[3%] group-hover/fan:shadow-[var(--shadow-fan-hover)] motion-safe:group-focus-visible/fan:-translate-y-[3%]',
  // 内侧左、右
  'z-[2] -translate-x-[56%] -rotate-7 scale-90 shadow-[var(--shadow-card)] motion-safe:group-hover/fan:-translate-x-[69%] motion-safe:group-hover/fan:-rotate-9 motion-safe:group-focus-visible/fan:-translate-x-[69%] motion-safe:group-focus-visible/fan:-rotate-9',
  'z-[2] translate-x-[56%] rotate-7 scale-90 shadow-[var(--shadow-card)] motion-safe:group-hover/fan:translate-x-[69%] motion-safe:group-hover/fan:rotate-9 motion-safe:group-focus-visible/fan:translate-x-[69%] motion-safe:group-focus-visible/fan:rotate-9',
  // 外侧左、右
  'z-[1] -translate-x-[108%] -rotate-14 scale-[0.82] shadow-[var(--shadow-card)] motion-safe:group-hover/fan:-translate-x-[133%] motion-safe:group-hover/fan:-rotate-[17deg] motion-safe:group-focus-visible/fan:-translate-x-[133%] motion-safe:group-focus-visible/fan:-rotate-[17deg]',
  'z-[1] translate-x-[108%] rotate-14 scale-[0.82] shadow-[var(--shadow-card)] motion-safe:group-hover/fan:translate-x-[133%] motion-safe:group-hover/fan:rotate-[17deg] motion-safe:group-focus-visible/fan:translate-x-[133%] motion-safe:group-focus-visible/fan:rotate-[17deg]',
];

/**
 * @param covers 按重要程度排好：[0] 放中间，其余依次放两侧
 * @param tint 封面不够时，空位「封套」的底色（例如作品主题色）
 * @param label 连中间那张都没有时，在中间封套上显示的字（作品名首字）
 * @param bigCenter 中卡在大屏上要清晰（卡宽 × DPR > 480）时传 true，用 960 缩略图
 */
export function CoverFan({
  covers,
  count = 3,
  tint,
  label,
  bigCenter,
  className,
}: {
  covers: FanCover[];
  count?: 3 | 5;
  tint?: string;
  label?: string;
  bigCenter?: boolean;
  className?: string;
}) {
  const slots = count === 5 ? SLOTS_5 : SLOTS_3;
  const card = count === 5 ? CARD_5 : CARD_3;
  // DOM 顺序无所谓，层级靠 z-index；先画两侧再画中间，读屏顺序也是从外到内
  const order = count === 5 ? [3, 4, 1, 2, 0] : [1, 2, 0];
  const envelope = tint ? `color-mix(in oklab, ${tint} 22%, var(--c-sunken))` : 'var(--c-sunken)';

  return (
    <div className={cn('relative w-full', count === 5 ? BOX_5 : BOX_3, className)}>
      {/* 地面投影：展开时跟着变宽 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-[28%] bottom-[4%] h-[9%] rounded-[50%] bg-black/20 blur-[10px] transition-[left,right] duration-500 ease-[var(--ease-out-soft)] group-hover/fan:inset-x-[20%] group-focus-visible/fan:inset-x-[20%] dark:bg-black/60"
      />
      {order.map((slot) => {
        const cover = covers[slot];
        return (
          <div key={slot} className={cn(CARD, card, slots[slot])} style={cover ? undefined : { background: envelope }}>
            {cover ? (
              <Thumb
                image={{ id: cover.imageId, rating: cover.rating, dominantColor: cover.color ?? envelope }}
                width={slot === 0 ? (bigCenter ? 960 : 480) : 240}
                focus={cover.focus}
                blurBadge={slot === 0 ? 'center' : 'none'}
                className="absolute inset-0"
              />
            ) : (
              slot === 0 &&
              label && (
                <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold text-fg-subtle">
                  {label.slice(0, 1)}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
