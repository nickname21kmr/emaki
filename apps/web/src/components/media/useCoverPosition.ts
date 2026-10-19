import type { FocusPoint } from '@emaki/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { coverPosition, pickFocus } from '@/lib/coverCrop';
import { usePrefs } from '@/lib/stores';

/** Inferred focal points need measurements; ordinary thumbnails and explicit manual crops stay CSS-only. */
export function useCoverPosition(rawFocus: FocusPoint | null | undefined, src: string) {
  // 外观设置「角色封面裁剪」：跟着构图时，大腿、脚是重点的图改用 legsY
  const mode = usePrefs((s) => s.coverCrop);
  const focus = rawFocus ? pickFocus(rawFocus, mode) : rawFocus;
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [measured, setMeasured] = useState<{ key: string; value: string } | null>(null);
  const x = focus?.x;
  const y = focus?.y;
  const space = focus?.space;
  const key = `${src}|${x}|${y}|${space}`;
  useLayoutEffect(() => {
    if (space !== 'image' || x === undefined || y === undefined) return;
    const frame = frameRef.current;
    const image = imageRef.current;
    if (!frame || !image) return;
    const update = () => {
      if (!image.complete || !image.naturalWidth || image.getAttribute('src') !== src) return;
      const p = coverPosition(
        { x, y, space },
        { width: image.naturalWidth, height: image.naturalHeight },
        { width: frame.clientWidth, height: frame.clientHeight },
      );
      const value = `${p.x * 100}% ${p.y * 100}%`;
      setMeasured(old => old?.key === key && old.value === value ? old : { key, value });
    };
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    image.addEventListener('load', update);
    update(); // Handles images already in the browser cache.
    return () => {
      observer.disconnect();
      image.removeEventListener('load', update);
    };
  }, [src, x, y, space, key]);
  const position = !focus ? undefined
    : space !== 'image' ? `${focus.x * 100}% ${focus.y * 100}%`
      : measured?.key === key ? measured.value : '50% 50%';
  return { frameRef, imageRef, position };
}
