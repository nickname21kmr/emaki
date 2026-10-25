import { useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import { useUndoReveal, type UndoReveal } from './stores';
import { madeHere } from './undoPlace';

/** 撤销后等这么久：刷新慢、要先跳页的也来得及；过了就算了 */
const REVEAL_TTL = 8000;

/**
 * 页面认领「刚撤销回来的东西」：返回这个页面要指给用户看的那一步（不是本页的、过期的是 null）。
 * 页面找到了对应的图 / 组就调 done()；找不到（还没刷新出来）就等下一次渲染再试。
 */
export function useUndoRevealTarget(): { reveal: UndoReveal | null; done: () => void } {
  const { pathname } = useLocation();
  const reveal = useUndoReveal((s) => s.reveal);
  useEffect(() => {
    if (!reveal) return;
    const t = window.setTimeout(
      () => {
        if (useUndoReveal.getState().reveal === reveal) useUndoReveal.setState({ reveal: null });
      },
      Math.max(0, REVEAL_TTL - (Date.now() - reveal.at)),
    );
    return () => window.clearTimeout(t);
  }, [reveal]);
  const done = useCallback(() => {
    if (useUndoReveal.getState().reveal === reveal) useUndoReveal.setState({ reveal: null });
  }, [reveal]);
  const mine = !!reveal && madeHere({ token: '', label: '', path: reveal.path }, pathname) && Date.now() - reveal.at < REVEAL_TTL;
  return { reveal: mine ? reveal : null, done };
}
