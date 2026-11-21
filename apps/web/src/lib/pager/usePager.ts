/**
 * 播放器的翻页（阅读器、看图器共用这一份）：轨道 + 触屏拖动 + 触控板左右滑。
 *
 *   const pager = usePager({ pos, hasPrev, hasNext, onForward, onBack });
 *   <PagerTrack pager={pager} pos={pos} count={n} keyOf={…} render={…} />   // 轨道上的前后一张已经摆好、解码好
 *   舞台：onPointerDown={(e) => zoom.handlers.onPointerDown(e) || pager.handlers.onPointerDown(e)} …，onWheel → pager.onWheel
 *
 * 点击、按键、滚轮、胶片条只要改 pos：±1 时轨道从当前画面接着滑过去（usePageTrack），更远直接换。
 * 触屏拖动跟手（useSwipePager），松手翻页时轨道从手指停的位置接着滑；触控板左右滑也跟手（useTrackpadPager）。
 * 竖着的拖动（看图器的下滑关闭）用 vertical 接进来，方向锁定还是同一处。
 */
import { useCallback } from 'react';
import { usePageTrack, useTrackpadPager } from './usePageTrack';
import { useSwipePager, type VerticalDrag } from './useSwipePager';

export function usePager(o: {
  /** 当前是第几格 */
  pos: number;
  /** 格子的意思变了（阅读器切单双页）：这一次不滑 */
  layout?: unknown;
  /** 右开：下一张在左边，往右滑是下一张 */
  rtl?: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  /** 不跟手（放大着、正在关闭、放映中） */
  disabled?: boolean;
  onForward: () => void;
  onBack: () => void;
  vertical?: VerticalDrag;
}) {
  const rtl = !!o.rtl;
  const swipe = useSwipePager({
    hasPrev: o.hasPrev,
    hasNext: o.hasNext,
    rtl,
    disabled: o.disabled,
    onForward: o.onForward,
    onBack: o.onBack,
    settle: (go) => (go === 'forward' ? o.onForward() : o.onBack()),
    vertical: o.vertical,
  });
  const trackRef = swipe.layerRef;
  usePageTrack({ pos: o.pos, layout: o.layout, rtl, trackRef });
  const trackpad = useTrackpadPager({
    trackRef,
    rtl,
    hasPrev: o.hasPrev,
    hasNext: o.hasNext,
    disabled: o.disabled,
    onForward: o.onForward,
    onBack: o.onBack,
  });
  const setTrack = useCallback(
    (el: HTMLDivElement | null) => {
      trackRef.current = el;
    },
    [trackRef],
  );

  return {
    /** 轨道元素（PagerTrack 自己接上） */
    setTrack,
    rtl,
    /** 舞台上的指针事件（排在 useTouchZoom 后面） */
    handlers: swipe.handlers,
    /** 舞台的 wheel：触控板左右滑归翻页时返回 true，调用方别再按自己的滚轮处理 */
    onWheel: trackpad,
    /** 打断跟手（开始捏合时） */
    cancel: swipe.cancel,
    /** 刚触摸过：浏览器随后补发的 click / dblclick / mousemove 不按鼠标处理 */
    fromTouch: swipe.fromTouch,
  };
}

export type Pager = ReturnType<typeof usePager>;
