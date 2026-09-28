import type { Character } from '@emaki/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';
import { useCoverMorph } from '@/lib/viewTransition';
import { Thumb } from './Thumb';

/**
 * 圆头像 + 名字 + 作品（MG-7）：「最近 30 天在收」、「常一起出现」、作品页的角色网格都用它。
 * 卡纸框：3px 纸色卡纸 + 1px 墨线外框；图注是名字 / 细线 / 作品名。悬停上浮 3px；badge 放在头像右下角（例如「+N」）。
 * 放进 overflow 容器时，容器上内边距要 ≥ 14px（pt-3.5）、左右到头像圆 ≥ 8px，否则外框会被裁。
 */
export function AvatarTile({
  character,
  workName,
  caption,
  badge,
  size = 'md',
  className,
}: {
  character: Character;
  workName?: string | null;
  /** 图注第二行（替代作品名），例如「同框 15 张」 */
  caption?: ReactNode;
  badge?: ReactNode;
  size?: 'md' | 'lg';
  className?: string;
}) {
  const lg = size === 'lg';
  const morph = useCoverMorph<HTMLSpanElement>(character.id);
  return (
    <Link
      to={`/characters/${character.id}`}
      viewTransition={morph.viewTransition}
      onClick={morph.onClick}
      onPointerEnter={morph.onPointerEnter}
      onPointerLeave={morph.onPointerLeave}
      className={cn('group/avatar flex shrink-0 flex-col items-center text-center outline-none', lg ? 'w-[136px]' : 'w-[116px]', className)}
    >
      <span className="relative">
        <span
          ref={morph.ref}
          className={cn(
            'relative block overflow-hidden rounded-full bg-sunken',
            'shadow-[var(--c-shadow-avatar)] outline-1 outline-offset-[7px] outline-rule',
            'transition-[translate,box-shadow,outline-color] duration-300 ease-[var(--ease-out-soft)]',
            'group-hover/avatar:-translate-y-[3px] group-hover/avatar:shadow-[var(--c-shadow-avatar-hover)] group-hover/avatar:outline-fg-muted',
            'group-focus-visible/avatar:outline-2 group-focus-visible/avatar:outline-shu',
            lg ? 'size-[112px]' : 'size-[92px]',
          )}
        >
          {character.coverImageId ? (
            <Thumb
              image={{
                id: character.coverImageId,
                rating: character.coverRating,
                dominantColor: character.coverColor ?? 'var(--c-sunken)',
              }}
              width={240}
              focus={character.coverFocus}
              blurBadge="none"
              className="absolute inset-0"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-2xl font-semibold text-fg-subtle">
              {character.name.slice(0, 1)}
            </span>
          )}
        </span>
        {badge && <span className="absolute -right-1.5 -bottom-0.5 z-[1]">{badge}</span>}
      </span>
      <span className="mt-4 w-full truncate text-[13px] font-semibold tracking-tight">{character.name}</span>
      {(caption ?? workName) && (
        <>
          <span aria-hidden className="mt-1.5 block h-px w-3.5 bg-rule" />
          <span className="mt-[5px] w-full truncate text-[10.5px] tracking-[.12em] text-fg-muted tabular">{caption ?? workName}</span>
        </>
      )}
    </Link>
  );
}
