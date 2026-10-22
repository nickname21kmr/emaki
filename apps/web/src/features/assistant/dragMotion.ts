import { clampPosition, type Position } from './presentation';

/** Move the compositor layer during a gesture; commit layout only on release. */
export function dragMotion(element: HTMLElement, rect: DOMRect, viewport: Position) {
  const origin = { x: rect.left, y: rect.top };
  let point = origin, frame: number | null = null;
  const previousWillChange = element.style.willChange;
  const clear = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    element.style.transform = '';
    element.style.willChange = previousWillChange;
  };
  return {
    move(next: Position) {
      point = clampPosition(next, rect.width, rect.height, viewport.x, viewport.y);
      if (frame !== null) return;
      element.style.willChange = 'transform';
      frame = requestAnimationFrame(() => {
        frame = null;
        element.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`;
      });
    },
    finish() {
      // Set the final layout before removing the transform, including a release
      // that arrives before the pending frame. React adopts this position once.
      Object.assign(element.style, { left: `${point.x}px`, top: `${point.y}px`, right: 'auto', bottom: 'auto' });
      clear();
      return point;
    },
    cancel: clear,
  };
}
