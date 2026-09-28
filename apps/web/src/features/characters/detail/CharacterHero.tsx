import type { Character, GetCharacterResponse, Work } from '@emaki/shared';
import { Ban, Ellipsis, GitMerge, ImageUp, PenLine, Pin, Play, RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode, Ref } from 'react';
import { Link, useViewTransitionState } from 'react-router';
import { collectImages, slideFilter, useSlideshow } from '@/components/media/lightbox/slideshow';
import { Thumb } from '@/components/media/Thumb';
import { Button, IconButton, Menu, MenuItem, MenuSeparator, Seal, Skeleton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCount, formatRelative } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';
import { useLightbox } from '@/lib/stores';
import { COVER_VT, useViewTransitionOn } from '@/lib/viewTransition';
import { CopyTag } from './HeroControls';

const EASE = EASE_OUT;
/** 假名或汉字：有就竖排，没有（HK416 这类）就横排 */
const CJK = /[぀-ヿ㐀-鿿]/;

/** 依次上浮进入，间隔 50ms */
const rise = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: EASE, delay: 0.08 + i * 0.05 },
});

/**
 * 角色扉页（SEL-8）：左边装裱过的图版，中间竖排大名和读音，右边奥付式资料表。
 * 直接排在纸上，没有大面积的模糊横幅；敏感封面只糊左边那张小图版。窄于 900px 时改成单列、名字横排。
 */
export function CharacterHero({
  character,
  works,
  related,
  newSinceLastVisit,
  heroRef,
  onTogglePin,
  pinPending,
  onEdit,
  onMerge,
  onExclude,
  onChangeCover,
  onRestoreCover,
}: {
  character: Character;
  works: Work[];
  related: GetCharacterResponse['related'];
  /** 进入页面那一刻的「+N」（进入后会被 markCharacterSeen 清零，所以要提前记下） */
  newSinceLastVisit: number;
  heroRef?: Ref<HTMLElement>;
  onTogglePin: () => void;
  pinPending?: boolean;
  onEdit: () => void;
  onMerge: () => void;
  onExclude: () => void;
  /** 打开「换封面」候选面板（CB-7） */
  onChangeCover: () => void;
  /** 手动设过封面时：交还给自动选图（MG-14） */
  onRestoreCover: () => void;
}) {
  const tint = works[0]?.color ?? 'var(--c-sunken)';
  const custom = character.source === 'custom' || !character.danbooruTag;
  const name = character.name;
  const vertical = CJK.test(name);
  const reading = character.aliases.find((a) => a !== name && CJK.test(a));
  const latin = character.aliases.filter((a) => !CJK.test(a));
  const partner = related[0];

  const rows: { label: string; value: ReactNode }[] = [];
  if (works.length > 0) {
    rows.push({
      label: '作品',
      value: (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {works.map((w) => (
            <Link key={w.id} to={`/works/${w.id}`} className="inline-flex items-center gap-1.5 transition-colors hover:text-shu">
              <span aria-hidden className="size-2 rounded-full" style={{ background: w.color }} />
              {w.name}
            </Link>
          ))}
        </span>
      ),
    });
  }
  rows.push({ label: '最近添加', value: character.lastAddedAt ? formatRelative(character.lastAddedAt) : '还没有' });
  if (partner) {
    rows.push({
      label: '最常一起出现',
      value: (
        <span>
          <Link to={`/characters/${partner.character.id}`} className="transition-colors hover:text-shu">
            {partner.character.name}
          </Link>
          <span className="text-fg-subtle tabular"> · 同框 {formatCount(partner.sharedCount)}</span>
        </span>
      ),
    });
  }
  rows.push({
    label: '上次查看后',
    value:
      newSinceLastVisit > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Seal glyph="新" variant="bai" size={16} />
          新增 {formatCount(newSinceLastVisit)} 张
        </span>
      ) : (
        <span className="text-fg-muted">没有新图</span>
      ),
  });
  rows.push({
    label: 'Danbooru',
    value: custom ? (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Seal glyph="自" size={16} />
        还没对上 Danbooru 标签
      </span>
    ) : (
      <CopyTag tag={character.danbooruTag!} className="-ml-3 h-6" />
    ),
  });
  if (latin.length > 0) rows.push({ label: '别名', value: <span className="text-fg-muted">{latin.join(' · ')}</span> });

  return (
    <div className="@container">
      <section
        ref={heroRef}
        aria-label={`${name} 的概况`}
        className="relative grid grid-cols-1 items-end gap-8 border-b border-rule pt-2 pb-8 @min-[900px]:grid-cols-[auto_auto_minmax(0,1fr)] @min-[900px]:gap-10"
      >
        {/* 书签带：主作品色 */}
        <span aria-hidden className="absolute top-0 bottom-8 -left-8 w-[3px]" style={{ background: tint }} />

        <Plate character={character} tint={tint} />

        {vertical && (
          <div className="hidden max-h-[300px] items-start gap-3 self-stretch pt-2 @min-[900px]:flex">
            {reading && <p className="tategaki mt-1 font-serif-cjk text-[13px] tracking-[.28em] text-fg-muted">{reading}</p>}
            <h2
              className={cn(
                'tategaki display-title max-h-[300px] animate-brush tracking-[.2em] [animation-delay:150ms]',
                [...name].length > 7 ? 'text-[34px]' : 'text-[44px]',
              )}
            >
              {truncateChars(name, 10)}
            </h2>
          </div>
        )}

        <div className="min-w-0 pb-1">
          {/* 横排名：名字没有汉字假名时总是横排；窄屏时也用它 */}
          <motion.h2
            {...rise(0)}
            className={cn('display-title mb-5 truncate text-[40px] leading-tight', vertical && '@min-[900px]:hidden')}
          >
            {name}
          </motion.h2>
          <motion.div {...rise(1)} className="flex items-baseline gap-1.5">
            <span className="numeral text-[72px]">{formatCount(character.imageCount)}</span>
            <span className="text-[13px] text-fg-muted">张</span>
            {character.otherCount > 0 && (
              <span className="ml-3 text-[12px] text-fg-subtle tabular">另有 {formatCount(character.otherCount)} 张漫画等</span>
            )}
            {character.imageCount > 1 && <SlideshowButton characterId={character.id} />}
          </motion.div>
          <dl className="mt-4 grid max-w-[560px] grid-cols-[88px_1fr] text-[12.5px]">
            {rows.map((r, i) => (
              <motion.div key={r.label} {...rise(i + 2)} className="col-span-2 grid grid-cols-subgrid">
                <dt className="border-b border-line py-2 text-fg-subtle">{r.label}</dt>
                <dd className="min-w-0 border-b border-line py-2">{r.value}</dd>
              </motion.div>
            ))}
          </dl>
        </div>

        {/* 右上角操作 */}
        <motion.div
          className="absolute top-0 right-0 flex items-center gap-0.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <Button variant="ghost" size="sm" icon={<ImageUp />} onClick={onChangeCover} className="mr-1">
            换封面
          </Button>
          <IconButton
            label={character.pinned ? '取消置顶' : '置顶'}
            active={character.pinned}
            disabled={pinPending}
            onClick={onTogglePin}
          >
            <Pin className={character.pinned ? 'fill-current text-shu' : undefined} />
          </IconButton>
          <IconButton label="编辑角色" onClick={onEdit}>
            <PenLine />
          </IconButton>
          <Menu width={200} trigger={<IconButton label="更多"><Ellipsis /></IconButton>}>
            <MenuItem icon={<GitMerge />} onSelect={() => afterMenuClose(onMerge)}>
              合并到其他角色…
            </MenuItem>
            {character.coverManual && (
              <MenuItem icon={<RotateCcw />} onSelect={onRestoreCover}>
                恢复自动封面
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Ban />} danger onSelect={() => afterMenuClose(onExclude)}>
              排除这个角色…
            </MenuItem>
          </Menu>
        </motion.div>
      </section>
    </div>
  );
}

/** 放映（SEL-16）：这个角色的全部插画，最多 500 张，按图库默认顺序 */
function SlideshowButton({ characterId }: { characterId: Character['id'] }) {
  const { start, pending } = useSlideshow();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => collectImages([{ ...slideFilter(), characterId }], 500))}
      className="ml-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted transition-colors hover:text-shu disabled:opacity-60"
    >
      {pending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
      放映
    </button>
  );
}

/** 左边装裱过的图版（3:4），点开看大图：从图版位置放大出来 */
function Plate({ character, tint }: { character: Character; tint: string }) {
  // 封面长成扉页（SEL-14）：过渡进行中图版带上共享名字，而且不再自己上浮淡入（新快照里必须是不透明的）
  const vtState = useViewTransitionState(`/characters/${character.id}`);
  const vtOn = useViewTransitionOn() && vtState;
  const cover = character.coverImageId;
  return (
    <motion.div
      className="w-[236px] shrink-0"
      initial={vtOn ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      {cover ? (
        <button
          type="button"
          aria-label="查看封面大图"
          onClick={(e) => {
            const r = e.currentTarget.querySelector('[data-plate]')!.getBoundingClientRect();
            useLightbox.getState().show([cover], 0, null, { left: r.left, top: r.top, width: r.width, height: r.height, thumb: 480 });
          }}
          className="group/plate block w-full cursor-zoom-in rounded-[3px] bg-raised p-2.5 shadow-plate ring-1 ring-line"
        >
          <span data-plate className="block" style={vtOn ? { viewTransitionName: COVER_VT } : undefined}>
            <Thumb
              image={{ id: cover, dominantColor: tint, rating: character.coverRating }}
              width={480}
              focus={character.coverFocus}
              eager
              className="aspect-[3/4] rounded-[2px]"
            />
          </span>
        </button>
      ) : (
        <div className="rounded-[3px] bg-raised p-2.5 shadow-plate ring-1 ring-line">
          <div className="flex aspect-[3/4] items-center justify-center rounded-[2px] bg-sunken">
            <span className="display-title text-[88px] text-fg-subtle">{character.name.slice(0, 1)}</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function truncateChars(s: string, n: number) {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join('') + '…' : s;
}

/** 与扉页等大的骨架，加载完成时不跳动 */
export function CharacterHeroSkeleton() {
  return (
    <div className="flex items-end gap-10 border-b border-rule pt-2 pb-8">
      <Skeleton className="aspect-[3/4] w-[236px] shrink-0 rounded-[3px]" />
      <Skeleton className="h-[260px] w-12" />
      <div className="flex-1 pb-1">
        <Skeleton className="h-16 w-36" />
        <div className="mt-4 max-w-[560px] space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 菜单项里打开弹窗 / 滚动时推迟一帧：等下拉菜单先关掉并把焦点还给触发按钮，
 * 否则弹窗的焦点锁和菜单的焦点归还会互相抢。
 */
function afterMenuClose(fn: () => void) {
  window.setTimeout(fn, 0);
}
