/**
 * 角色封面优先保留头部。标签仅用于估计原图中的主体位置，并非人脸检测。
 * 返回 image 坐标，由前端按实际卡片比例换算裁切；不能直接用于 object-position。
 * 服饰、腿脚标签不表示头的位置，不参与推断。手动焦点不经过此函数。
 */
import type { FocusPoint } from '@emaki/shared';

/** 推断要用到的全部标签（给 SQL 取标签用） */
export const FOCUS_TAGS = ['chibi', 'close-up', 'portrait', 'upper_body', 'full_body', 'head_out_of_frame'];

export function inferCoverFocus(tags: Iterable<readonly [string, number]>): FocusPoint {
  const m = new Map(tags);
  const has = (name: string) => (m.get(name) ?? 0) >= 0.5;
  // 特写、Q 版的大头占比高；原图没有头时也不硬猜一个头部位置。
  const y = has('head_out_of_frame') || has('chibi') || has('close-up') ? 0.5
    : has('portrait') ? 0.4
      : has('upper_body') ? 0.35
        : has('full_body') ? 0.3
          : 0.28;
  return { x: 0.5, y, space: 'image' };
}
