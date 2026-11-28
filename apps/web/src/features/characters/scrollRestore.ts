/** 算「用户自己动了」的事件：滚轮、触摸、按键、按下鼠标（点链接、拖滚动条） */
const USER_MOVES = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * delay 毫秒后调 restore()（角色页等淡入动画结束再回到上次的滚动位置）；这之前 target 上有任何一种用户操作就作废：
 * 人已经开始滚了，再跳回上次的位置等于把他拽走。返回取消函数（卸载时调；到点、作废之后再调没有副作用）
 */
export function restoreUnlessMoved(target: Listenable, restore: () => void, delay: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 按住不放的自动重复、只按了修饰键、横着扫的触控板手势都不算「开始滚了」
  const moved = (e: Event) => {
    const k = e as Partial<KeyboardEvent> & Partial<WheelEvent>;
    if (e.type === 'keydown' && (k.repeat || ['Alt', 'Control', 'Shift', 'Meta'].includes(k.key ?? ''))) return;
    if (e.type === 'wheel' && Math.abs(k.deltaY ?? 0) < Math.abs(k.deltaX ?? 0)) return;
    cancel();
  };
  const cancel = () => {
    clearTimeout(timer);
    for (const type of USER_MOVES) target.removeEventListener(type, moved, true);
  };
  // 捕获阶段：页面自己的处理拦掉了事件也照样算
  for (const type of USER_MOVES) target.addEventListener(type, moved, { capture: true, passive: true });
  timer = setTimeout(() => {
    cancel();
    restore();
  }, delay);
  return cancel;
}
