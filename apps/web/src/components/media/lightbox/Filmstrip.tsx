import type { ID } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Thumb } from '../Thumb';
import { findCachedImage } from './cache';

/** 只画当前这张前后各这么多张：列表可能有几千张 */
const SPAN = 40;

/**
 * 看图器底部的胶片条（和合集阅读器的一样）：鼠标移到底边时展开，当前这张居中、朱色描边，点一张跳过去。
 * 缩略图的尺寸、分级从列表缓存里取；取不到的（比如从别处打开的）按敏感处理，先模糊。
 */
export function Filmstrip({ ids, index, onPick, hidden }: { ids: ID[]; index: number; onPick: (index: number) => void; hidden?: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const from = Math.max(0, index - SPAN);
  const to = Math.min(ids.length, index + SPAN + 1);
  const items = useMemo(
    () => (open ? ids.slice(from, to).map((id, k) => ({ id, i: from + k, meta: findCachedImage(client, id) })) : []),
    [open, ids, from, to, client],
  );
  useEffect(() => {
    if (open) ref.current?.querySelector('[data-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [open, index]);
  // 藏起来时没有 mouseleave：收起，再出现时不会直接是展开的
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);
  if (hidden || ids.length < 2) return null;

  return (
    <div
      data-lb-chrome
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className={cn('absolute inset-x-0 bottom-0 z-20', open ? 'h-[104px]' : 'h-5')}
    >
      <div
        ref={ref}
        // 普通鼠标只有竖向滚轮：换成横向滚动
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        }}
        className={cn(
          'flex h-full items-end gap-1.5 overflow-x-auto bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 transition-opacity duration-200 scrollbar-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {items.map(({ id, i, meta }) => (
          <button
            key={id}
            type="button"
            data-current={i === index}
            onClick={() => onPick(i)}
            aria-label={`第 ${i + 1} 张`}
            className={cn(
              'shrink-0 rounded-[3px] outline-none transition-opacity duration-150',
              i === index ? 'ring-2 ring-shu' : 'opacity-60 hover:opacity-100 focus-visible:opacity-100',
            )}
            style={{ width: meta ? Math.max(40, Math.min(160, Math.round((72 * meta.width) / meta.height))) : 54 }}
          >
            <Thumb
              image={meta ?? { id, rating: 'general', dominantColor: '#2a2a2a' }}
              width={240}
              blurBadge="none"
              forceBlur={!meta}
              className="h-[72px] w-full rounded-[3px]"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
