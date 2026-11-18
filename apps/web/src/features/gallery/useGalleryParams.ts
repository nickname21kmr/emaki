import { BROWSE_THEMES, CONTENT_KINDS, type BrowseTheme, type ContentKind, type ImageSort, type ListImagesQuery, type Rating } from '@emaki/shared';
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { themeQuery } from '@/lib/customTheme';
import { useCustomThemes } from '@/lib/queries';
import { usePrefs } from '@/lib/stores';
import { withParam } from '@/lib/urlPrefs';

/**
 * 图库的筛选状态全部放在 URL 里（?q= &kind= &anim= &rating= &orient= &fav= &sort= &order=），
 * 刷新 / 前进后退 / 从看图器点标签跳过来都能还原。
 * 看哪些类型是本机偏好（usePrefs.galleryKinds），但它决定列表里有哪些图，所以也一直写在 URL 里：URL 没写时把偏好补进去，
 * 助手拿到的页面上下文和用户看到的一致（P5，附录 #32）。
 */

export type Orientation = NonNullable<ListImagesQuery['orientation']>;
export type SortOrder = 'asc' | 'desc';

export const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];
export const ORIENTATIONS: Orientation[] = ['portrait', 'landscape', 'square'];
export type GallerySort = Exclude<ImageSort, 'page'>;
export const SORTS: GallerySort[] = ['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random'];

export interface GalleryFilters {
  q: string;
  /** 内容类型；URL 没写时用偏好（默认只看插画，D2）。不算「筛选」，清除筛选也不动它 */
  kind: ContentKind[] | 'all';
  /** 只看动图（?anim=1，D5）：和类型是两个维度，在当前类型里再筛 */
  animated: boolean;
  rating: Rating[];
  orientation: Orientation | undefined;
  /** 画面：腿·足、泳装…（?theme=） */
  theme: BrowseTheme | undefined;
  /** 自定义画面的 id（?custom=）；和 theme 互斥 */
  custom: string | undefined;
  favorite: boolean;
  /** 画师（Danbooru 标签，?artist=），从合集页的「画师」点进来 */
  artist: string | undefined;
  sort: GallerySort;
  order: SortOrder;
}

/** 每种排序「自然」的方向：文件名 A→Z，其余新 / 大的在前 */
export const defaultOrder = (sort: ImageSort): SortOrder => (sort === 'fileName' ? 'asc' : 'desc');

function parseKind(raw: string | null, fallback: ContentKind[] | 'all'): ContentKind[] | 'all' {
  if (raw === null) return fallback;
  if (raw === 'all') return 'all';
  const set = new Set(raw.split(','));
  const kinds = CONTENT_KINDS.filter((k) => set.has(k));
  return kinds.length ? kinds : 'all';
}

/** 本机偏好里存的类型：去掉不认识的（D5 之前的 animated），去光了回到默认的只看插画 */
function validKinds(stored: ContentKind[] | 'all'): ContentKind[] | 'all' {
  if (stored === 'all') return 'all';
  const kinds = CONTENT_KINDS.filter((k) => stored.includes(k));
  return kinds.length ? kinds : ['illustration'];
}

const kindParam = (kind: ContentKind[] | 'all') => (kind === 'all' ? 'all' : kind.join(','));

function parse(params: URLSearchParams, kindFallback: ContentKind[] | 'all'): GalleryFilters {
  const ratingSet = new Set((params.get('rating') ?? '').split(','));
  const orient = params.get('orient');
  const sortParam = params.get('sort');
  const sort = SORTS.includes(sortParam as GallerySort) ? (sortParam as GallerySort) : 'addedAt';
  const orderParam = params.get('order');
  return {
    q: params.get('q') ?? '',
    kind: parseKind(params.get('kind'), kindFallback),
    animated: params.get('anim') === '1',
    // 按固定顺序输出，保证 query key 稳定
    rating: RATINGS.filter((r) => ratingSet.has(r)),
    orientation: ORIENTATIONS.includes(orient as Orientation) ? (orient as Orientation) : undefined,
    theme: (BROWSE_THEMES as readonly string[]).includes(params.get('theme') ?? '') ? (params.get('theme') as BrowseTheme) : undefined,
    custom: params.get('custom') || undefined,
    favorite: params.get('fav') === '1',
    artist: params.get('artist') || undefined,
    sort,
    order: orderParam === 'asc' || orderParam === 'desc' ? orderParam : defaultOrder(sort),
  };
}

/** ownsKind：类型由这一页决定（图库）。别册页的类型来自路由，不把图库的类型偏好补进 URL */
export function useGalleryParams({ ownsKind = true }: { ownsKind?: boolean } = {}) {
  const [params, setParams] = useSearchParams();
  const storedKinds = usePrefs((s) => s.galleryKinds);
  const kindPref = useMemo(() => validKinds(storedKinds), [storedKinds]);
  const setKindPref = usePrefs((s) => s.setGalleryKinds);
  const filters = useMemo(() => parse(params, kindPref), [params, kindPref]);

  const update = useCallback(
    (patch: Partial<GalleryFilters>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const cur = parse(prev, kindPref);
          const merged = { ...cur, ...patch };
          // 内置画面和自定义画面只能选一个
          if (patch.theme) merged.custom = undefined;
          if (patch.custom) merged.theme = undefined;
          const set = (key: string, value: string | undefined) => {
            if (value) next.set(key, value);
            else next.delete(key);
          };
          set('q', merged.q.trim() || undefined);
          // 类型：一直写在 URL 里；用户换了类型就记成新偏好
          if (patch.kind !== undefined) setKindPref(merged.kind);
          if (ownsKind || patch.kind !== undefined) set('kind', kindParam(merged.kind));
          set('anim', merged.animated ? '1' : undefined);
          set('rating', merged.rating.length ? RATINGS.filter((r) => merged.rating.includes(r)).join(',') : undefined);
          set('orient', merged.orientation);
          set('theme', merged.theme);
          set('custom', merged.custom);
          set('fav', merged.favorite ? '1' : undefined);
          set('artist', merged.artist);
          set('sort', merged.sort === 'addedAt' ? undefined : merged.sort);
          // 换排序时回到该排序的默认方向；方向等于默认值时不写进 URL
          const order = patch.sort && patch.order === undefined ? defaultOrder(merged.sort) : merged.order;
          set('order', order === defaultOrder(merged.sort) ? undefined : order);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, kindPref, setKindPref, ownsKind],
  );

  // URL 里还没写类型（从侧栏点进来）：把偏好补进去，不多一条历史
  const kindMissing = ownsKind && params.get('kind') === null;
  useEffect(() => {
    if (kindMissing) setParams((prev) => (prev.get('kind') !== null ? prev : withParam(prev, 'kind', kindParam(kindPref))), { replace: true });
  }, [kindMissing, kindPref, setParams]);

  // 自定义画面换成它的标签；id 找不到（被删了、设置还没加载）就当没选
  const customThemes = useCustomThemes();
  const customTheme = filters.custom ? customThemes.find((t) => t.id === filters.custom) : undefined;
  const customTags = useMemo(() => themeQuery(customTheme), [customTheme]);

  const query = useMemo<Omit<ListImagesQuery, 'cursor'>>(
    () => ({
      q: filters.q || undefined,
      kind: filters.kind === 'all' ? undefined : filters.kind,
      animated: filters.animated || undefined,
      rating: filters.rating.length ? filters.rating : undefined,
      orientation: filters.orientation,
      theme: filters.theme,
      ...customTags,
      favorite: filters.favorite || undefined,
      artist: filters.artist,
      sort: filters.sort,
      order: filters.sort === 'random' ? undefined : filters.order,
    }),
    [filters, customTags],
  );

  const hasFilters = !!(
    filters.q ||
    filters.animated ||
    filters.rating.length ||
    filters.orientation ||
    filters.theme ||
    customTheme ||
    filters.favorite ||
    filters.artist
  );

  const clearFilters = useCallback(
    () =>
      update({ q: '', animated: false, rating: [], orientation: undefined, theme: undefined, custom: undefined, favorite: false, artist: undefined }),
    [update],
  );

  return { filters, query, update, hasFilters, clearFilters, customThemes };
}
