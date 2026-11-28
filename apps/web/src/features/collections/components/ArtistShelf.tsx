import type { Artist } from '@emaki/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useGridBox } from '@/components/media/ImageGrid';
import { Thumb } from '@/components/media/Thumb';
import { formatCount } from '@/lib/format';
import { ARTIST_GRID, artistGridLayout } from './artistGrid';

const leaveScrollAlone = () => {};

/**
 * 合集页的「画师」：识别出来的画师，按张数排。点进去是图库按这位画师筛选。
 * 认不出画师的图不在这里。
 *
 * 真实库有两千多位，按行虚拟化（写法照 components/media/CardGrid.tsx）：只画视口附近的几行，
 * 列数、卡宽、间距照原来的 CSS 网格算（artistGrid.ts），长相和整页高度不变，后退回来滚动位置照常恢复。
 */
export function ArtistShelf({ list }: { list: Artist[] }) {
  const { scrollRef, containerRef, width, scrollMargin } = useGridBox();
  const { cols, cardHeight } = artistGridLayout(width);
  // 卡片高度先按算式估，挂上后量第一行的真实高度：浏览器排出来的和算的差在亚像素，系统把字号放大时差得更多；
  // 用量到的，每一行的位置才和原来的 CSS 网格一样，行也不会叠在一起
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const rowHeight = measured?.width === width ? measured.height : cardHeight;
  const rowCount = Math.ceil(list.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    gap: ARTIST_GRID.rowGap,
    overscan: 3,
    scrollMargin,
    // 虚拟列表在这里只管算哪几行在画面里，不许它动滚动位置：缺省它一挂上就把滚动容器滚到自己记的位置（一开始是 0）。
    // 画师这一节常比书架晚挂上（名单几百 KB，后到），那一下会把人从正在看的地方拽回页首；后退回来时还可能冲掉 AppShell 刚恢复的位置。
    // 所以起始位置取滚动容器当时的位置，之后只跟着滚动事件走
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
    scrollToFn: leaveScrollAlone,
  });
  // 行高变了（窗口缩放、量到了真实高度）让虚拟列表重算每行的位置；在绘制之前做，不闪
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const firstRow = useRef<HTMLDivElement>(null);
  const hasRows = virtualRows.length > 0;
  useLayoutEffect(() => {
    // 差一点点也要用量到的：每行差千分之几像素，两千多位画师排到底就差出好几像素
    const height = firstRow.current?.getBoundingClientRect().height;
    if (height && height !== rowHeight) setMeasured({ width, height });
  }, [width, hasRows, rowHeight]);

  return (
    <div ref={containerRef} role="list" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualRows.map((vr, i) => {
        const start = vr.index * cols;
        return (
          <div
            key={vr.key}
            ref={i === 0 ? firstRow : undefined}
            role="presentation"
            className="absolute left-0 grid w-full"
            style={{
              top: vr.start - scrollMargin,
              gridTemplateColumns: `repeat(${cols}, minmax(${ARTIST_GRID.minWidth}px, 1fr))`,
              columnGap: ARTIST_GRID.columnGap,
            }}
          >
            {list.slice(start, start + cols).map((a) => (
              <ArtistCard key={a.tag} artist={a} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 一位画师的卡片。memo：滚动时虚拟列表整个重渲染，已经在画面里的卡片不用跟着重画 */
const ArtistCard = memo(function ArtistCard({ artist: a }: { artist: Artist }) {
  return (
    <div role="listitem">
      <Link to={`/gallery?artist=${encodeURIComponent(a.tag)}`} className="group block focus-visible:outline-none">
        <div className="aspect-[3/4] overflow-hidden rounded-lg bg-sunken shadow-sm ring-1 ring-line transition-[box-shadow,transform] duration-300 group-hover:-translate-y-0.5 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-shu">
          {a.cover && (
            <Thumb image={a.cover} width={480} className="size-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.03]" blurBadge="corner" />
          )}
        </div>
        <div className="mt-2.5 truncate text-[13.5px] font-medium" title={[a.name, ...a.aliases].join(' / ')}>
          {a.name}
        </div>
        <div className="truncate text-xs text-fg-muted">
          <span className="tabular">{formatCount(a.imageCount)} 张</span>
          {/* 有推特显示账号；名字是日文名时再给出标签，方便对照 */}
          <span className="ml-1.5 text-fg-subtle">{a.twitter ? `@${a.twitter}` : a.name !== a.tag.replace(/_/g, ' ') ? a.tag : ''}</span>
        </div>
      </Link>
    </div>
  );
});
