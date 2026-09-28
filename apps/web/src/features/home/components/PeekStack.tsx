import type { Character, ImageItem } from '@emaki/shared';
import { Thumb } from '@/components/media/Thumb';
import { cn } from '@/lib/cn';

/*
 * 待处理卡片右侧的「预览小样」：几张缩略图像照片一样叠着，
 * 鼠标移到卡片上时轻轻散开（父元素需要有 group class）。
 *
 * 注意：Thumb 根节点自带 relative，这里的定位都放在外层 div 上，
 * 否则 absolute 会被 relative 覆盖。
 */

const MOVE = 'transition-[translate,rotate] duration-500 ease-[var(--ease-out-soft)]';
const PHOTO = 'rounded-[8px] ring-2 ring-raised shadow-card overflow-hidden';

/** 三张扇形叠放：未识别 */
const FAN = [
  '-translate-x-6 -rotate-[9deg] group-hover:-translate-x-10 group-hover:-rotate-[15deg]',
  'z-10 group-hover:-translate-y-1.5',
  'translate-x-6 rotate-[9deg] group-hover:translate-x-10 group-hover:rotate-[15deg]',
];

export function PhotoFan({ images }: { images: ImageItem[] }) {
  if (!images.length) return null;
  // 只有一两张时也从中间那张开始放，保持对称
  const slots = images.length === 1 ? [1] : images.length === 2 ? [0, 2] : [0, 1, 2];
  return (
    <div className="relative h-[92px] w-[70px]">
      {images.slice(0, 3).map((img, i) => (
        <div key={img.id} className={cn('absolute inset-0', PHOTO, MOVE, FAN[slots[i] ?? 1])}>
          <Thumb image={img} width={240} className="size-full" />
        </div>
      ))}
    </div>
  );
}

/** 两张错开叠放 + 中间一个「≈ / =」记号：重复 */
export function PhotoPair({ images, exact }: { images: ImageItem[]; exact: boolean }) {
  const [a, b] = images;
  if (!a || !b) return null;
  return (
    <div className="relative h-[88px] w-[112px]">
      <div
        className={cn(
          'absolute top-0 left-0 h-[76px] w-[60px] -rotate-[5deg] group-hover:-translate-x-2 group-hover:-rotate-[8deg]',
          PHOTO,
          MOVE,
        )}
      >
        <Thumb image={a} width={240} className="size-full" />
      </div>
      <div
        className={cn(
          'absolute right-0 bottom-0 h-[76px] w-[60px] rotate-[4deg] group-hover:translate-x-2 group-hover:rotate-[7deg]',
          PHOTO,
          MOVE,
        )}
      >
        <Thumb image={b} width={240} className="size-full" />
      </div>
      <span className="absolute top-1/2 left-1/2 z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-raised font-display text-[15px] leading-none text-fg-muted shadow-card ring-1 ring-line">
        {exact ? '=' : '≈'}
      </span>
    </div>
  );
}

/** 一排圆形头像互相压着，悬停时松开一点：自建角色 */
export function AvatarRow({ characters }: { characters: Character[] }) {
  const withCover = characters.filter((c) => c.coverImageId).slice(0, 3);
  if (!withCover.length) return null;
  return (
    <div className="flex items-center">
      {withCover.map((c, i) => (
        <div
          key={c.id}
          className={cn(
            'size-12 overflow-hidden rounded-full ring-[2.5px] ring-raised shadow-card transition-[margin] duration-500 ease-[var(--ease-out-soft)]',
            i > 0 && '-ml-4 group-hover:-ml-2',
          )}
          style={{ zIndex: withCover.length - i }}
        >
          <Thumb
            image={{ id: c.coverImageId!, dominantColor: 'var(--c-sunken)', rating: c.coverRating }}
            focus={c.coverFocus}
            width={240}
            className="size-full"
          />
        </div>
      ))}
    </div>
  );
}
