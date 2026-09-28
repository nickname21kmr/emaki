/**
 * 自动封面的焦点（T28，CB-8 + 用户要求）：按构图标签推断裁剪位置，x 固定居中。
 * 用户不喜欢一律偏上；腿、脚是画面重点时反而要稍微往下。返回 null = 居中。
 * 标签分数达到 0.5 才算，按顺序取第一条命中的。
 */
import type { FocusPoint } from '@emaki/shared';

const LEG_FOCUS = ['thigh_focus', 'feet_focus', 'foot_focus', 'ass_focus'];
const CLOSE = ['upper_body', 'portrait', 'close-up'];
const LEGS = ['thighs', 'legs', 'thighhighs', 'pantyhose', 'barefoot', 'feet'];

/** 推断要用到的全部标签（给 SQL 取标签用） */
export const FOCUS_TAGS = [...LEG_FOCUS, 'full_body', ...CLOSE, 'cowboy_shot', ...LEGS];

export function inferCoverFocus(tags: Iterable<readonly [string, number]>): FocusPoint | null {
  const m = new Map(tags);
  const any = (names: string[], th = 0.5) => names.some((n) => (m.get(n) ?? 0) >= th);
  const y = any(LEG_FOCUS)
    ? 0.65 // 腿、脚是画面重点
    : any(['full_body'])
      ? 0.08 // 全身像：看得到头顶
      : any(CLOSE)
        ? 0.28
        : any(['cowboy_shot'])
          ? 0.18
          : any(LEGS, 0.6)
            ? 0.58 // 画面里有腿但不是特写：比居中稍微往下
            : null;
  return y === null ? null : { x: 0.5, y };
}
