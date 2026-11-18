/**
 * 设置 →「手机访问」里「等你批准的请求」那一段在不在屏幕上。在的话批准提示不再另外弹（AccessPrompts）：
 * 请求就在眼前列着，浮在上面的卡片只会重复、还会盖住这一节的开关。滚走了提示又弹出来。
 */
import { useCallback } from 'react';
import { create } from 'zustand';

export const useRequestListOnScreen = create<{ onScreen: boolean }>(() => ({ onScreen: false }));

/** 给那一段的 ref：挂上时开始看它进出视口，卸下时算不在（React 19 的 ref 回调可以返回清理函数） */
export function useRequestListRef() {
  return useCallback((el: HTMLElement | null) => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => useRequestListOnScreen.setState({ onScreen: !!e?.isIntersecting }));
    io.observe(el);
    return () => {
      io.disconnect();
      useRequestListOnScreen.setState({ onScreen: false });
    };
  }, []);
}
