import type { Character, ThumbWidth } from '@emaki/shared';
import { Link } from 'react-router';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { shouldBlur } from '@/lib/blur';
import { formatCount } from '@/lib/format';
import { useBlurPrefs } from '@/lib/stores';
import { useCoverMorph } from '@/lib/viewTransition';
import { Thumb } from './Thumb';

/** 张数：只出现在漫画、截图等里的角色（插画 0 张，书架末尾点「显示」才列出）写成「漫画等 N 张」，不写「0 张」 */
export function countLabel(c: Pick<Character, 'imageCount' | 'otherCount'>) {
  return c.imageCount === 0 && c.otherCount > 0 ? `漫画等 ${formatCount(c.otherCount)} 张` : `${formatCount(c.imageCount)} 张`;
}

/**
 * 角色封面卡，两种版式（MG-13 / SEL-4）：
 * - overlay（默认）：封面铺满 + 底部渐变，名字 / 作品 · 张数压在图上。Top、首页「收得最多」、作品页 Top 4 用它。
 * - plate：上面是图版（圆角 12px、柔和投影），名字和张数写在图版下方的纸上，图上不压字。书架用它。
 * showNew：右上角「+N」（ink 胶囊 + ok 小点）；Top 类排行不显示。
 * 不显示排名数字（用户 2026-09-27 定）。
 */
export function CharacterCover({
  character,
  workName,
  size = 'md',
  variant = 'overlay',
  showNew = true,
  thumbWidth,
  className,
  onClick,
}: {
  character: Character;
  workName?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'overlay' | 'plate';
  showNew?: boolean;
  /** 缩略图宽度：调用方按「卡宽 × DPR」决定；不传时 lg / xl 用 960，其余 480 */
  thumbWidth?: ThumbWidth;
  className?: string;
  onClick?: () => void;
}) {
  // 封面只按分级模糊，不传 kind（T27 保证自动封面不会选到照片）
  const blurred = shouldBlur({ rating: character.coverRating }, useBlurPrefs());
  // 封面长成扉页（SEL-14）：plate 挂在图版上，overlay 挂在图片层上
  const morph = useCoverMorph<HTMLDivElement>(character.id);
  const linkProps = {
    to: `/characters/${character.id}`,
    viewTransition: morph.viewTransition,
    onPointerEnter: morph.onPointerEnter,
    onPointerLeave: morph.onPointerLeave,
    onClick: () => {
      morph.onClick();
      onClick?.();
    },
  };
  const width = thumbWidth ?? (size === 'xl' || size === 'lg' ? 960 : 480);
  const cover = character.coverImageId ? (
    <Thumb
      image={{ id: character.coverImageId, dominantColor: character.coverColor ?? 'var(--c-sunken)', rating: character.coverRating }}
      width={width}
      focus={character.coverFocus}
      className="absolute inset-0"
      // 模糊时不做悬停放大：放大会盖掉模糊用的 scale，露出边缘（MG-4）
      revealOnHover
      imgClassName={blurred ? undefined : 'duration-[900ms] group-hover/cover:scale-[1.045]'}
    />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center text-5xl font-semibold text-fg-subtle">
      {character.name.slice(0, 1)}
    </div>
  );
  const newBadge = showNew && character.newCount > 0 && (
    <Badge tone={variant === 'plate' ? 'ink' : 'glass'} dot="var(--c-ok)" className="absolute top-2.5 right-2.5">
      +{formatCount(character.newCount)}
    </Badge>
  );

  if (variant === 'plate') {
    return (
      <Link {...linkProps} className={cn('group/cover group/reveal block outline-none', className)}>
        {/* 图版 overflow-hidden 会裁掉印框，所以印框挂在外面这层上（SEL-15） */}
        <div className="focus-frame-target rounded-[var(--radius-plate)]">
          <div
            ref={morph.ref}
            className={cn(
              'relative aspect-[3/4] overflow-hidden rounded-[var(--radius-plate)] bg-sunken shadow-[var(--shadow-plate)]',
              'transition-[translate,box-shadow] duration-500 ease-[var(--ease-out-soft)] group-hover/cover:-translate-y-0.5 group-hover/cover:shadow-lift',
            )}
          >
            {cover}
            {newBadge}
          </div>
        </div>
        <div className="mt-2.5 px-0.5">
          <div className="truncate text-[14px] font-semibold tracking-tight">{character.name}</div>
          <div className="mt-0.5 truncate text-[12px] text-fg-muted tabular">
            {workName ? `${workName} · ` : ''}
            {countLabel(character)}
          </div>
        </div>
      </Link>
    );
  }

  const nameSize = { sm: 'text-[13px]', md: 'text-[15px]', lg: 'text-lg', xl: 'text-[26px]' }[size];
  return (
    <Link
      {...linkProps}
      className={cn(
        'group/cover group/reveal relative block overflow-hidden rounded-[var(--radius-plate)] bg-sunken',
        'transition-[translate,box-shadow] duration-500 ease-[var(--ease-out-soft)] hover:-translate-y-0.5 hover:shadow-lift',
        className,
      )}
    >
      <div ref={morph.ref} className="absolute inset-0">
        {cover}
      </div>
      <div className="absolute inset-0 scrim-bottom" />
      {newBadge}
      <div className={cn('absolute inset-x-0 bottom-0 text-white', size === 'xl' ? 'p-6' : 'p-3.5')}>
        <div className={cn('truncate font-semibold tracking-tight drop-shadow-sm', nameSize)}>{character.name}</div>
        <div className={cn('mt-0.5 truncate text-white/70 tabular', size === 'xl' ? 'text-[13px]' : 'text-[11.5px]')}>
          {workName ? `${workName} · ` : ''}
          {countLabel(character)}
        </div>
      </div>
    </Link>
  );
}
