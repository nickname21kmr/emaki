/**
 * 动效参数的唯一来源（SEL-2）。组件里不要再写缓动数组字面量，从这里取。
 * CSS 那边对应 index.css 的 --ease-out-soft / --ease-fan。
 */

/** 默认缓出：快起慢收，无回弹（= --ease-out-soft） */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** 扇形叠卡展开：约 3% 过冲，比 --ease-spring 克制（= --ease-fan） */
export const EASE_FAN = [0.3, 1.25, 0.5, 1] as const;

/** 常用时长（秒） */
export const DURATION = { fast: 0.18, base: 0.35, slow: 0.55 } as const;

/** 弹簧：印章、选中这类小元素用 */
export const SPRING = { type: 'spring', stiffness: 420, damping: 32 } as const;
