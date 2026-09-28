import type { ID } from '@emaki/shared';
import { ImageOff } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { cn } from '@/lib/cn';
import { useImage } from '@/lib/queries';

/**
 * 预览缩略图叠成一小摞「照片」：静止时微微错开旋转，所在行悬停时像扇子一样展开。
 * 依赖外层有 `group/rule`。
 */
export function PhotoStack({ ids, className }: { ids: ID[]; className?: string }) {
  const shown = ids.slice(0, 4);
  const mid = (shown.length - 1) / 2;
  return (
    <div className={cn('relative h-[92px] w-[150px] shrink-0', className)} aria-hidden>
      {shown.map((id, i) => {
        const d = i - mid;
        // 静止：间距 16px、每张转 5°；展开：间距 28px、转 9°，两边略微下沉成弧形（TR-9 放大）
        const vars = {
          '--x': `${i * 16 + (4 - shown.length) * 8}px`,
          '--y': `${Math.abs(d) * 1.5}px`,
          '--r': `${d * 5}deg`,
          '--hx': `${i * 28 + (4 - shown.length) * 14 - 6}px`,
          '--hy': `${Math.abs(d) * 3 - 3}px`,
          '--hr': `${d * 9}deg`,
          zIndex: i,
        } as CSSProperties;
        return <StackPhoto key={id} id={id} style={vars} />;
      })}
    </div>
  );
}

function StackPhoto({ id, style }: { id: ID; style: CSSProperties }) {
  // 取详情是为了拿到分级：敏感图在这里也要遵守模糊偏好
  const { data: image, isError } = useImage(id);
  return (
    <div
      style={style}
      className={cn(
        'absolute top-2 left-0 h-[74px] w-[56px] overflow-hidden rounded-[8px] bg-sunken shadow-card ring-2 ring-raised',
        'transition-transform duration-500 ease-[var(--ease-out-soft)]',
        '[transform:translate(var(--x),var(--y))_rotate(var(--r))]',
        'group-hover/rule:[transform:translate(var(--hx),var(--hy))_rotate(var(--hr))]',
      )}
    >
      {image ? (
        <Thumb image={image} width={240} className="size-full" />
      ) : isError ? (
        <div className="flex size-full items-center justify-center text-fg-subtle">
          <ImageOff className="size-3.5" />
        </div>
      ) : (
        <div className="skeleton size-full rounded-none" />
      )}
    </div>
  );
}
