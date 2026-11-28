import { inferCoverFocus, showcaseQuery, type ImageItem, type ListImagesQuery } from '@emaki/shared';
import { keepPreviousData, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RotateCw } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { collectImages, slideFilter, useSlideshow } from '@/components/media/lightbox/slideshow';
import { Thumb } from '@/components/media/Thumb';
import { Button, SectionTitle, Skeleton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDimensions } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useCharacter, useImage, useWorks } from '@/lib/queries';
import { dayKey, daySeed } from '@/lib/random';
import { useLightbox, usePrefs } from '@/lib/stores';
import { lastPlate, plateShape, useDailyPlateState } from '../dailyPlateState';
import { cn } from '@/lib/cn';

const SITE: Record<string, string> = { pixiv: 'pixiv', twitter: 'X', danbooru: 'Danbooru', fanbox: 'FANBOX', other: '' };

/**
 * 今日一枚（SEL-9）：每天从收藏里抽一张插画当作「本期图版」大幅陈列，旁边竖排题名，配一张奥付小表。
 * 先从收藏里抽，没有收藏就从认出角色的插画里抽，再没有就从全部插画里抽。
 * 开着模糊时只抽识别过、分级是全年龄的图（showcase 场合，共用的 showcaseQuery）：还没识别的图分级默认是全年龄，可能其实是限制级。
 */
/** 抽图的先后：收藏 → 认出角色的 → 全部 */
const TIERS: ListImagesQuery[] = [{ favorite: true }, { status: 'recognized' }, {}];

/** 抽图的查询：DailyPlate 自己和首页的提前抽（usePrefetchDailyPlate）用同一份，查询键才对得上 */
const dailyPlateQuery = (seed: number, blur: boolean) =>
  queryOptions({
    queryKey: ['images', 'daily', seed, blur] as const,
    queryFn: async (): Promise<ImageItem | null> => {
      const base: ListImagesQuery = { kind: ['illustration'], sort: 'random', seed, limit: 1, ...showcaseQuery(blur) };
      for (const extra of TIERS) {
        const page = await api.images({ ...base, ...extra });
        if (page.items[0]) return page.items[0];
      }
      return null;
    },
    staleTime: Infinity,
  });

/** 今天的种子：按日期，加上这个窗口里按过几次「换一张」 */
function useDailySeed() {
  const day = dayKey();
  const choice = useDailyPlateState();
  const shuffle = choice.day === day ? choice.shuffle : 0;
  return { seed: daySeed(`${day}:${shuffle}`), next: () => choice.next(dayKey()) };
}

/**
 * 首页一挂上就去抽，和汇总接口并行：DailyPlate 要等汇总回来才挂，等它自己发请求就晚了一轮，大图也跟着晚。
 * 上次没有图版（空库、没有可抽的）就不提前抽，那三次请求多半白发。
 */
export function usePrefetchDailyPlate() {
  const client = useQueryClient();
  const { seed } = useDailySeed();
  const blur = usePrefs((s) => s.blurSensitive);
  const [expected] = useState(lastPlate.get);
  useEffect(() => {
    if (expected) void client.prefetchQuery(dailyPlateQuery(seed, blur));
  }, [client, seed, blur, expected]);
}

export function DailyPlate() {
  const { seed, next } = useDailySeed();
  const blur = usePrefs((s) => s.blurSensitive);
  // 换一张时先留着上一张，不闪回占位
  const plate = useQuery({ ...dailyPlateQuery(seed, blur), placeholderData: keepPreviousData });
  useHotkey('r', next);

  const img = plate.data;
  // 记下这次有没有抽到：下次打开首页，抽到之前占不占位置看它（dailyPlateState.ts 的 lastPlate）
  const settled = plate.isSuccess && !plate.isPlaceholderData;
  const has = !!img;
  useEffect(() => {
    if (settled) lastPlate.set(has);
  }, [settled, has]);

  if (!img) {
    // 还在抽：上次有图版就先占着它的位置，抽到时下面几块不会被顶下去半屏。
    // 上次没有的不占（可能根本没有能抽的：模糊开着又没分级过），先放占位再收掉反而每次都跳一下
    return plate.isPending && lastPlate.get() ? <DailyPlateSkeleton /> : null;
  }
  return (
    <section aria-label="今日一枚">
      <PlateTitle onNext={next} />
      <Plate key={img.id} img={img} seed={seed} />
    </section>
  );
}

function PlateTitle({ onNext }: { onNext?: () => void }) {
  return (
    <SectionTitle
      hint="每天从你的收藏里抽一张"
      actions={
        <Button variant="ghost" size="sm" icon={<RotateCw className="size-3.5" />} onClick={onNext} disabled={!onNext}>
          换一张
        </Button>
      }
    >
      今日一枚
    </SectionTitle>
  );
}

/*
 * 图版的外层排法和图框：真正的图版（Plate）和抽到之前的占位（DailyPlateSkeleton）共用这几样，
 * 占位的高度、手机竖屏上的排法才和图版对得上。
 */
const PLATE_GRID = {
  tall: 'grid grid-cols-[auto_minmax(260px,1fr)] items-end gap-8',
  wide: 'grid grid-cols-[minmax(0,1fr)_260px] items-end gap-8',
  // 手机竖屏（A1）：图在上、文字在下
  compact: 'compact:grid-cols-1 compact:gap-5',
};
const PLATE_FRAME = 'rounded-[var(--radius-plate)] compact:mx-auto compact:h-auto! compact:max-h-[70vh] compact:max-w-full';
const plateFrameStyle = (ar: number, tall: boolean): CSSProperties =>
  tall ? { height: 440, aspectRatio: ar } : { aspectRatio: ar, maxHeight: 460, width: '100%' };

/** 占位按竖图排（插画多是竖图，图框固定高 440）；抽到横图时高度会差几十像素 */
const TYPICAL = plateShape(7, 10);

/**
 * 抽到之前的占位：和图版同一套标题、外层和图框。DailyPlate 自己用，首页的骨架（HomeSkeleton）在同一个位置也放它，
 * 汇总回来、图抽到时这一块的大小都不变。
 */
export function DailyPlateSkeleton() {
  return (
    <section aria-hidden>
      <PlateTitle />
      <div className={cn(PLATE_GRID.tall, PLATE_GRID.compact)}>
        {/* 空的图框自己撑不出宽度：手机竖屏上给满宽，高度照图版的规矩按比例来、最高 70vh */}
        <div className={cn(PLATE_FRAME, 'skeleton compact:w-full')} style={plateFrameStyle(TYPICAL.ar, true)} />
        <div className="min-w-0 pb-1">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="mt-3.5 h-36 w-8" />
          <div className="mt-4 border-t border-rule">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex justify-between gap-4 border-b border-line py-2.5">
                <Skeleton className="h-3 w-8" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-4 h-3 w-32" />
        </div>
      </div>
    </section>
  );
}

function Plate({ img, seed }: { img: ImageItem; seed: number }) {
  const slideshow = useSlideshow();
  // 放映今天的 20 张（SEL-16）：同一个种子、同样的先后，所以第一张就是这张图版
  const play = () =>
    slideshow.start(() =>
      collectImages(
        TIERS.map((extra) => ({ ...slideFilter(), sort: 'random' as const, seed, limit: 20, ...extra })),
        20,
      ),
    );
  const { ar, tall } = plateShape(img.width, img.height);
  const { data: charData } = useCharacter(img.characterIds[0]);
  const { data: detail } = useImage(img.id);
  // 只按 id 找作品名，和顺序无关：和统计条、角色页用同一份作品列表（同一个查询键），不另拉一遍
  const works = useWorks({ sort: 'imageCount' });
  const c = charData?.character;
  // A character's crop only belongs to its cover image; other artwork uses
  // the same inference algorithm with its own composition tags.
  const focus = c?.coverImageId === img.id && c.coverFocus
    ? c.coverFocus
    : inferCoverFocus(detail?.tags.map((t) => [t.tag, t.score] as const) ?? []);
  const workName = c?.workIds[0] ? works.data?.find((w) => w.id === c.workIds[0])?.name : undefined;
  const name = c ? [...c.name].slice(0, 8).join('') : '无题';
  const site = img.source ? [SITE[img.source.site], img.source.artist].filter(Boolean).join(' · ') : '';
  const folder = img.relPath.includes('/') ? img.relPath.split('/')[0] : '（根目录）';
  const open = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    useLightbox.getState().show([img.id], 0, null, { left: r.left, top: r.top, width: r.width, height: r.height, thumb: 960 });
  };

  return (
    <div className={cn(tall ? PLATE_GRID.tall : PLATE_GRID.wide, PLATE_GRID.compact)}>
      <button
        type="button"
        onClick={open}
        // 不加 overflow-hidden：键盘聚焦时的四角印框画在图版外面（SEL-15），圆角裁切交给 Thumb 自己
        className={cn('focus-frame animate-unroll cursor-zoom-in shadow-plate', PLATE_FRAME)}
        style={plateFrameStyle(ar, tall)}
        aria-label="看大图"
      >
        <Thumb image={img} width={960} focus={focus} original eager className="size-full rounded-[var(--radius-plate)]" />
      </button>
      <div className="min-w-0 pb-1">
        <div className="kicker">图版 · 第 {img.id} 号</div>
        <div className="mt-3.5 flex gap-3.5">
          <span className="tategaki display-title animate-brush text-[30px] tracking-[.16em] [animation-delay:250ms]">{name}</span>
          {workName && <span className="tategaki font-serif-cjk text-[12px] tracking-[.24em] text-fg-muted">{workName}</span>}
        </div>
        <dl className="mt-4 border-t border-rule text-[12px]">
          <Row label="尺寸">
            <span className="tabular">{formatDimensions(img.width, img.height)}</span>
          </Row>
          {site && <Row label="来源">{site}</Row>}
          {!c && (
            <Row label="文件">
              <span className="block truncate">{img.fileName}</span>
            </Row>
          )}
          <Row label="所在">{folder}</Row>
        </dl>
        <div className="mt-4 flex gap-4 text-[12.5px] font-medium">
          <button type="button" onClick={open} className="text-fg-muted transition-colors hover:text-fg">
            看大图 →
          </button>
          {c && (
            <Link to={`/characters/${c.id}`} className="text-fg-muted transition-colors hover:text-fg">
              角色页 →
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={play}
          disabled={slideshow.pending}
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted transition-colors hover:text-shu disabled:opacity-60"
        >
          {slideshow.pending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
          放映今天的 20 张
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
