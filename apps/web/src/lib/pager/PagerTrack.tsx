/**
 * 播放器的轨道：前一格、当前格、后一格并排摆着（每格错开「宽度 + TRACK_GAP」），由 usePager 滑动。
 * 每格按 keyOf 认：翻过去的那一格在 DOM 里还是同一个元素，图片不重新加载、不重新解码，所以不闪。
 * 不是当前格的不可交互（inert），只是摆着等滑进来；里面的 <img data-neighbor> 先 decode()，滑进来的第一帧就有图。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { Pager } from './usePager';
import { slotStyle } from './usePageTrack';

export function PagerTrack({
  pager,
  pos,
  count,
  keyOf,
  render,
  className,
  slotClassName,
  neighbors = true,
}: {
  pager: Pager;
  pos: number;
  /** 一共几格（pos 的范围是 0..count-1） */
  count: number;
  keyOf: (i: number) => string;
  /** current：是不是当前格（只有当前格接缩放、接点击） */
  render: (i: number, current: boolean) => ReactNode;
  className?: string;
  slotClassName?: string;
  /** 不摆前后格（看图器放映时交叉淡化，只要当前这一张） */
  neighbors?: boolean;
}) {
  const slots = neighbors ? [pos - 1, pos, pos + 1] : [pos];
  const keys = slots.filter((i) => i >= 0 && i < count).map(keyOf).join('|');
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 换了一格以后，新摆上来的邻格先解码
    ref.current?.querySelectorAll<HTMLImageElement>('[data-pager-slot]:not([data-current]) img').forEach((img) => void img.decode().catch(() => {}));
  }, [keys]);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        pager.setTrack(el);
      }}
      data-pager-track
      className={cn('absolute inset-0', className)}
    >
      {slots.map((i) =>
        i < 0 || i >= count ? null : (
          <div
            key={keyOf(i)}
            data-pager-slot
            data-current={i === pos || undefined}
            aria-hidden={i !== pos || undefined}
            inert={i !== pos || undefined}
            style={slotStyle(i - pos, pager.rtl)}
            className={cn('absolute inset-0', slotClassName)}
          >
            {render(i, i === pos)}
          </div>
        ),
      )}
    </div>
  );
}
