/**
 * 网格滚到快见底时要不要拉下一页（ImageGrid、CardGrid 共用）：已渲染的最后一行离末尾 ahead 行以内就拉。
 *
 * measured：容器宽度量出来了没有。没量出来时行还没排，「最后一行」是 -1、行数是 0，照上面的算法恒成立：
 * 网格每次挂上（第一次打开、从别的页后退回来）都会多拉一页，已加载的页越攒越多，之后每次刷新都要多取。
 * 条件用「量出来了」而不是「有行」：第一页一张都没有、后面还有的时候要能接着拉。
 */
export function shouldLoadMore(s: {
  hasMore?: boolean;
  loadingMore?: boolean;
  measured: boolean;
  /** 已渲染的最后一行的下标（含预渲染的几行）；一行都没渲染是 -1 */
  lastRendered: number;
  rowCount: number;
  ahead: number;
}): boolean {
  return !!s.hasMore && !s.loadingMore && s.measured && s.lastRendered >= s.rowCount - s.ahead;
}
