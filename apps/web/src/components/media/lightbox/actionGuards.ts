import type { ID } from '@emaki/shared';

/** useMutate 的结果里守卫要看的两样 */
interface Running<V> {
  isPending: boolean;
  variables?: V;
}

/**
 * 这个动作在这张图上还在进行（请求加随后的刷新）：返回它的参数，否则 undefined。
 *
 * isPending 要等整轮刷新做完才放开，而且一个 hook 只跟最新那一次请求：拿它当整把锁的话，
 * 收藏完马上翻到下一张再按 F，第二张会被悄悄吞掉。所以只看是不是同一张：
 * 同一张上还没做完就先不接（值还没落定，再按是照旧值重复提交），换了一张照常接。
 */
export function pendingOn<V extends { id: ID }>(m: Running<V>, id: ID | undefined): V | undefined {
  return m.isPending && id !== undefined && m.variables?.id === id ? m.variables : undefined;
}

/**
 * 排除 / 移到回收站现在接不接。这把锁故意不分是哪张图：两个里有一个还没做完、或者刚处理的那张还在原地停留
 * （LEAVE_HOLD_MS）时都不接，再按同一个键不会落到下一张上。
 */
export function canLeave(s: { excluding: boolean; trashing: boolean; holding: boolean }): boolean {
  return !s.excluding && !s.trashing && !s.holding;
}
