import type { FocusPoint } from '@emaki/shared';

export interface ImageSize { width: number; height: number }
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));

/**
 * object-position specifies a fraction of the OVERFLOW, not a point in the image.
 * Center the subject in the visible crop and clamp at the image edges. Near-matching
 * aspect ratios keep their full composition; the no-overflow axis stays centered.
 * Legacy/manual positions keep their original semantics at every aspect ratio.
 */
export function coverPosition(focus: FocusPoint, image: ImageSize, frame: ImageSize): { x: number; y: number } {
  const x = clamp(focus.x), y = clamp(focus.y);
  if (focus.space !== 'image') return { x, y };
  if (![image.width, image.height, frame.width, frame.height].every(n => Number.isFinite(n) && n > 0))
    return { x: 0.5, y: 0.5 };
  const scale = Math.max(frame.width / image.width, frame.height / image.height);
  const position = (subject: number, full: number, visible: number) => {
    const overflow = full - visible;
    return overflow < 0.5 ? 0.5 : clamp((subject * full - visible / 2) / overflow);
  };
  return {
    x: position(x, image.width * scale, frame.width),
    y: position(y, image.height * scale, frame.height),
  };
}
