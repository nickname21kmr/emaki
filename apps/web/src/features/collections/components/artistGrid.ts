/**
 * 画师网格的排法。原来是 CSS 网格 `grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-7`，
 * 按行虚拟化以后列数、卡宽要自己算；这里照 CSS 的规则算，同一个宽度下卡片的位置和大小和原来一样。
 * 手机竖屏也是这一套（原来的 CSS 没有另外的断点），不走 lib/viewport.ts 的 cardMinWidth。
 */
export const ARTIST_GRID = {
  /** 卡片最小宽度（minmax 的下限） */
  minWidth: 150,
  /** gap-x-5 */
  columnGap: 20,
  /** gap-y-7 */
  rowGap: 28,
  /** 封面 aspect-[3/4]：高 = 宽 × 4/3 */
  coverRatio: 4 / 3,
  /** 封面下面两行字：mt-2.5（10）+ 名字一行（13.5px × 1.5）+ 张数一行（text-xs，16） */
  caption: 10 + 20.25 + 16,
} as const;

export interface ArtistGridLayout {
  /** 一行几张：auto-fill 能放下几个「最小宽度 + 间距」就是几列，至少一列 */
  cols: number;
  /** 每张卡的宽度（列宽平分剩下的宽度；容器比最小宽度还窄时一列、不小于最小宽度） */
  cardWidth: number;
  /** 估的卡片高度：封面 + 图注。真实高度由浏览器排出来，差在亚像素，ArtistShelf 挂上后量一次 */
  cardHeight: number;
}

export function artistGridLayout(width: number): ArtistGridLayout {
  const { minWidth, columnGap, coverRatio, caption } = ARTIST_GRID;
  const cols = Math.max(1, Math.floor((width + columnGap) / (minWidth + columnGap)));
  const cardWidth = Math.max(minWidth, (width - columnGap * (cols - 1)) / cols);
  return { cols, cardWidth, cardHeight: cardWidth * coverRatio + caption };
}
