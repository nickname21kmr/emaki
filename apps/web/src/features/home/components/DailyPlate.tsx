import type { ImageItem, ListImagesQuery } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { Play, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { collectImages, slideFilter, useSlideshow } from '@/components/media/lightbox/slideshow';
import { Thumb } from '@/components/media/Thumb';
import { Button, SectionTitle, Skeleton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDimensions } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useCharacter, useWorks } from '@/lib/queries';
import { dayKey, daySeed } from '@/lib/random';
import { useLightbox, usePrefs } from '@/lib/stores';

const SITE: Record<string, string> = { pixiv: 'pixiv', twitter: 'X', danbooru: 'Danbooru', fanbox: 'FANBOX', other: '' };

/**
 * 今日一枚（SEL-9）：每天从收藏里抽一张插画当作「本期图版」大幅陈列，旁边竖排题名，配一张奥付小表。
 * 先从收藏里抽，没有收藏就从认出角色的插画里抽，再没有就从全部插画里抽。
 * 开着模糊时只抽识别过、分级是全年龄的图：还没识别的图分级默认是全年龄，可能其实是限制级。
 */
/** 抽图的先后：收藏 → 认出角色的 → 全部 */
const TIERS: ListImagesQuery[] = [{ favorite: true }, { status: 'recognized' }, {}];

function useDailyPlate(seed: number) {
  const blur = usePrefs((s) => s.blurSensitive);
  return useQuery({
    queryKey: ['images', 'daily', seed, blur],
    queryFn: async (): Promise<ImageItem | null> => {
      const base: ListImagesQuery = { kind: ['illustration'], sort: 'random', seed, limit: 1, ...(blur ? { rating: ['general'], rated: true } : {}) };
      for (const extra of TIERS) {
        const page = await api.images({ ...base, ...extra });
        if (page.items[0]) return page.items[0];
      }
      return null;
    },
    staleTime: Infinity,
  });
}

export function DailyPlate() {
  const [shuffle, setShuffle] = useState(0);
  const seed = daySeed(`${dayKey()}:${shuffle}`);
  const plate = useDailyPlate(seed);
  useHotkey('r', () => setShuffle((n) => n + 1));

  const img = plate.data;
  if (plate.isSuccess && !img) return null;
  return (
    <section aria-label="今日一枚">
      <SectionTitle
        hint="每天从你的收藏里抽一张"
        actions={
          <Button variant="ghost" size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => setShuffle((n) => n + 1)}>
            换一张
          </Button>
        }
      >
        今日一枚
      </SectionTitle>
      {img ? <Plate key={img.id} img={img} seed={seed} /> : <Skeleton className="h-[440px] w-full rounded-[var(--radius-plate)]" />}
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
  const ar = Math.min(Math.max(img.width / Math.max(img.height, 1), 0.66), 2.4);
  const tall = ar < 1.2;
  const { data: charData } = useCharacter(img.characterIds[0]);
  const works = useWorks();
  const c = charData?.character;
  const workName = c?.workIds[0] ? works.data?.find((w) => w.id === c.workIds[0])?.name : undefined;
  const name = c ? [...c.name].slice(0, 8).join('') : '无题';
  const site = img.source ? [SITE[img.source.site], img.source.artist].filter(Boolean).join(' · ') : '';
  const folder = img.relPath.includes('/') ? img.relPath.split('/')[0] : '（根目录）';
  const open = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    useLightbox.getState().show([img.id], 0, null, { left: r.left, top: r.top, width: r.width, height: r.height, thumb: 960 });
  };

  return (
    <div className={tall ? 'grid grid-cols-[auto_minmax(260px,1fr)] items-end gap-8' : 'grid grid-cols-[minmax(0,1fr)_260px] items-end gap-8'}>
      <button
        type="button"
        onClick={open}
        // 不加 overflow-hidden：键盘聚焦时的四角印框画在图版外面（SEL-15），圆角裁切交给 Thumb 自己
        className="focus-frame animate-unroll cursor-zoom-in rounded-[var(--radius-plate)] shadow-plate"
        style={tall ? { height: 440, aspectRatio: ar } : { aspectRatio: ar, maxHeight: 460, width: '100%' }}
        aria-label="看大图"
      >
        <Thumb image={img} width={960} eager className="size-full rounded-[var(--radius-plate)]" />
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
