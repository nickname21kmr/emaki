import type { ID } from '@emaki/shared';
import { useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef } from 'react';
import { useViewTransitionState } from 'react-router';
import { usePrefetchCharacter } from './queries';

/**
 * 封面长成扉页（SEL-14）：点角色封面时，被点的那张封面平滑地移动、放大成扉页左侧的图版；后退时反向缩回。
 *
 * 同一时刻只能有一个元素叫 COVER_VT，重名会让浏览器取消整个过渡。
 * 同一个角色可能同时出现在 Top 行和书架里，所以名字用命令式挂：只有被点的那张才带名字。
 */
export const COVER_VT = 'emaki-cover';

let tagged: HTMLElement | null = null;
/** 最近一次从列表进扉页的角色：后退回列表时由它那张封面接住过渡 */
let lastCoverId: ID | null = null;

export function tagCover(el: HTMLElement | null) {
  if (tagged && tagged !== el) tagged.style.viewTransitionName = '';
  tagged = el;
  if (el) el.style.viewTransitionName = COVER_VT;
}

const supported = () => typeof document !== 'undefined' && 'startViewTransition' in document;

/** 这次跳转用不用 View Transition：减少动效或浏览器不支持时普通跳转 */
export function useViewTransitionOn() {
  return !useReducedMotion() && supported();
}

/**
 * 列表里的角色封面（CharacterCover / AvatarTile）：ref 挂在图版上，viewTransition 给 Link，
 * onClick 给名字，悬停 120ms 预取角色详情，让扉页同帧就有图。
 */
export function useCoverMorph<T extends HTMLElement>(id: ID) {
  const ref = useRef<T>(null);
  const on = useViewTransitionOn();
  const vt = useViewTransitionState(`/characters/${id}`);
  const prefetch = usePrefetchCharacter();
  const timer = useRef(0);

  // 从扉页后退回来：谁先挂载谁接住（上一张带名字的已经随列表卸载了）
  useLayoutEffect(() => {
    if (on && vt && id === lastCoverId && !tagged?.isConnected) tagCover(ref.current);
  }, [on, vt, id]);

  return {
    ref,
    viewTransition: on,
    onClick: () => {
      if (!on) return;
      // 在扉页里点别的角色：扉页图版自己带名字，这里不抢
      if (window.location.pathname.startsWith('/characters/')) return tagCover(null);
      tagCover(ref.current);
      lastCoverId = id;
    },
    onPointerEnter: () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => prefetch(id), 120);
    },
    onPointerLeave: () => window.clearTimeout(timer.current),
  };
}
