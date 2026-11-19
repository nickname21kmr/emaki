/**
 * 合集（T38d）的文案、书架分组、阅读进度。
 * 合集是总称：本子、画集按文件夹成册；组图是收在一起的散图（手动挑的，或同一投稿自动收拢）。
 */
import {
  bookBlurContext,
  COLLECTION_KIND_META,
  collectionTitle,
  volumeUnit,
  type CollectionKind,
  type CollectionSummary,
  type CoverRef,
  type ID,
} from '@emaki/shared';
import { BookImage, BookOpen, Layers, type LucideIcon } from 'lucide-react';
import { blurReason, type BlurPrefs } from './blur';

const ICON: Record<CollectionKind, LucideIcon> = { group: Layers, doujin: BookOpen, artbook: BookImage };

/** 合集类型的名称、量词、印字、说明只有一份（packages/shared 的 COLLECTION_KIND_META），这里只加图标 */
export const COLLECTION_META = Object.fromEntries(
  (Object.keys(COLLECTION_KIND_META) as CollectionKind[]).map((k) => [k, { ...COLLECTION_KIND_META[k], icon: ICON[k] }]),
) as Record<CollectionKind, (typeof COLLECTION_KIND_META)[CollectionKind] & { icon: LucideIcon }>;

/** 无题时的显示名只有一种写法（packages/shared 的 collectionTitle，附录 #38） */
export const displayTitle = (c: Pick<CollectionSummary, 'title' | 'folderName'>) => collectionTitle(c);

/** 展会 · 社团（作者） */
export function byline(c: Pick<CollectionSummary, 'event' | 'circle' | 'artist'>): string {
  const who = c.circle && c.artist ? `${c.circle}（${c.artist}）` : (c.circle ?? c.artist);
  return [c.event, who].filter(Boolean).join(' · ');
}

export type ShelfUnit = { type: 'single'; c: CollectionSummary } | { type: 'series'; key: string; items: CollectionSummary[] };

/**
 * 书架单元：同一系列 ≥ 2 本合成一个系列卡。
 * 排序（RV-C-5）：无题的排最后；其余按单元总页数降序，相同再按标题。
 * keepOrder：调用方已经排好了（系列页按第几话），不再按页数重排。
 */
export function toShelfUnits(list: CollectionSummary[], { keepOrder = false } = {}): ShelfUnit[] {
  const series = new Map<string, CollectionSummary[]>();
  for (const c of list) if (c.seriesKey) series.set(c.seriesKey, [...(series.get(c.seriesKey) ?? []), c]);
  const units: ShelfUnit[] = [];
  const done = new Set<string>();
  for (const c of list) {
    const items = c.seriesKey ? series.get(c.seriesKey)! : [c];
    if (items.length >= 2) {
      if (done.has(c.seriesKey!)) continue;
      done.add(c.seriesKey!);
      units.push({ type: 'series', key: c.seriesKey!, items: [...items].sort((a, b) => (a.volumeNo ?? 1e9) - (b.volumeNo ?? 1e9)) });
    } else units.push({ type: 'single', c });
  }
  if (keepOrder) return units;
  const first =(u: ShelfUnit) => (u.type === 'single' ? u.c : u.items[0]!);
  const pages = (u: ShelfUnit) => (u.type === 'single' ? u.c.pageCount : u.items.reduce((n, c) => n + c.pageCount, 0));
  const collator = new Intl.Collator('ja', { numeric: true });
  return units.sort(
    (a, b) =>
      (first(a).title === null ? 1 : 0) - (first(b).title === null ? 1 : 0) ||
      pages(b) - pages(a) ||
      collator.compare(first(a).title ?? '', first(b).title ?? ''),
  );
}

/** 连载按「话」，其余按「册」：和服务端解析卷号 / 话数用同一个判断（packages/shared 的 volumeUnit） */
export const unitWord = (items: Pick<CollectionSummary, 'folderName'>[]) =>
  items.some((c) => volumeUnit(c.folderName) === '话') ? '话' : '册';

const KEY = (id: string) => `emaki.read.v1.${id}`;
/**
 * 阅读进度（读到第几页）留在这台设备上，不搬到服务端（P5 判断过，docs/core-architecture.md 第 6 节「设置的归属」）：
 * 它是浏览的痕迹（像浏览器的历史、滚动位置），不是对图库的整理决定——不参与撤销、不该触发变更传播和 library-changed
 * 让别的页面重拉，助手也不需要读写它；每翻一页写一次，放服务端就是每次翻页写库。Emaki 只监听本机，多设备接着读不是现在的场景
 */
export const readProgress = {
  get(id: string): number | null {
    try {
      const v = Number(localStorage.getItem(KEY(id)));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  },
  set(id: string, page: number): void {
    try {
      localStorage.setItem(KEY(id), String(page));
    } catch {
      /* 隐私模式等：不记进度 */
    }
  },
};

/**
 * 布面：开着模糊时，没有封面，或者封面不能不打码显示（共用的 blurReason：封面敏感；本子封面还没识别过、分级不可信，
 * 本子封面大多敏感，bookBlurContext），都换成布面精装。
 */
export function shouldCloth(c: Pick<CollectionSummary, 'covers' | 'kind' | 'coverTagged'>, prefs: BlurPrefs): boolean {
  if (!prefs.blurSensitive) return false;
  const cover = c.covers[0];
  if (!cover) return true;
  return blurReason({ rating: cover.rating, rated: c.coverTagged }, prefs, bookBlurContext(c.kind)) !== null;
}

/**
 * 书封面下面露出的底页：无人值守地露出来，按 showcase（开着模糊时只露分级可信的全年龄页）。
 * 封面识别过才当底页的分级可信（底页和封面同一批识别）
 */
export const showUnderPage = (c: Pick<CollectionSummary, 'coverTagged'>, under: Pick<CoverRef, 'rating'>, prefs: BlurPrefs) =>
  blurReason({ rating: under.rating, rated: c.coverTagged }, prefs, 'showcase') === null;

/** 组图的来历，写在书卡、详情页的小字里 */
export const groupOrigin = (c: Pick<CollectionSummary, 'membership'>) => (c.membership === 'post' ? '同一投稿' : '手动收集');

/** 组图的顺序：手动收集的在前，再按最近加图（书架上的组图、「收进组图」弹窗） */
export const compareGroups = (a: CollectionSummary, b: CollectionSummary) =>
  Number(b.membership !== 'post') - Number(a.membership !== 'post') || (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? '');

/** 「全部」里同一投稿的组图不超过这么多就直接摆出来，多了收成一行（和图库「自动收拢」一个思路：多就收，少就摊开） */
export const POSTS_INLINE = 12;

/** 合集页看的是哪一类：null = 全部 */
export type ShelfView = CollectionKind | 'artist' | null;

/**
 * 合集页要拉哪几份列表。同一投稿的组图在大库上有几千组，不再一次全拉回来：
 * - books = 本子、画集；groups = 手动收集的组图；posts = 同一投稿的组图。数目（副标题、每类的小字、「另有 N 组」）都读 counts；
 * - 「全部」里同一投稿的超过 POSTS_INLINE 组时收成一行（folded），点「显示」（showPosts）才拉；不超过时照样摆出来；
 * - fetchPosts：真要发请求。数目还是上一次搜索的（fresh = false，比如刚清空搜索框）时先不发，免得照旧的数目把几千组拉回来，
 *   等这次的数目回来再定；这期间 posts 照常显示上一次的结果。
 */
export function shelfPlan(view: ShelfView, postGroups: number | undefined, showPosts: boolean, fresh = true) {
  const none = { books: false, groups: false, posts: false, fetchPosts: false, folded: false };
  if (view === 'artist') return none;
  if (view === 'doujin' || view === 'artbook') return { ...none, books: true };
  if (view === 'group') return { ...none, groups: true, posts: true, fetchPosts: true };
  const many = postGroups !== undefined && postGroups > POSTS_INLINE;
  const posts = showPosts || (postGroups !== undefined && postGroups > 0 && !many);
  return { books: true, groups: true, posts, fetchPosts: posts && (showPosts || fresh), folded: many && !showPosts };
}

/** 「收进组图」弹窗列多少组 */
export const PICKER_LIMIT = 50;

/**
 * 「收进组图」弹窗的候选：手动收集的、同一投稿的各请求最近加图的 PICKER_LIMIT + 1 组（服务端按 q 搜过，多一组是给 excludeId 留的），
 * 合起来手动收集的在前、取前 PICKER_LIMIT 组，不列当前所在的组图
 */
export const pickerGroups = (manual: CollectionSummary[], posts: CollectionSummary[], excludeId?: ID) =>
  [...manual, ...posts]
    .filter((c) => c.id !== excludeId)
    .sort(compareGroups)
    .slice(0, PICKER_LIMIT);
