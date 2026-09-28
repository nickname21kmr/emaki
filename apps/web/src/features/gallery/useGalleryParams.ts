import { BROWSE_THEMES, CONTENT_KINDS, type BrowseTheme, type ContentKind, type ImageSort, type ListImagesQuery, type Rating } from '@emaki/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { usePrefs } from '@/lib/stores';

/**
 * 图库的筛选状态全部放在 URL 里（?q= &kind= &rating= &orient= &fav= &sort= &order=），
 * 刷新 / 前进后退 / 从看图器点标签跳过来都能还原。
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
  rating: Rating[];
  orientation: Orientation | undefined;
  /** 画面：腿·足、泳装…（?theme=） */
  theme: BrowseTheme | undefined;
  favorite: boolean;
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

const sameKinds = (a: ContentKind[] | 'all', b: ContentKind[] | 'all') =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.join() === b.join());

function parse(params: URLSearchParams, kindFallback: ContentKind[] | 'all'): GalleryFilters {
  const ratingSet = new Set((params.get('rating') ?? '').split(','));
  const orient = params.get('orient');
  const sortParam = params.get('sort');
  const sort = SORTS.includes(sortParam as GallerySort) ? (sortParam as GallerySort) : 'addedAt';
  const orderParam = params.get('order');
  return {
    q: params.get('q') ?? '',
    kind: parseKind(params.get('kind'), kindFallback),
    // 按固定顺序输出，保证 query key 稳定
    rating: RATINGS.filter((r) => ratingSet.has(r)),
    orientation: ORIENTATIONS.includes(orient as Orientation) ? (orient as Orientation) : undefined,
    theme: (BROWSE_THEMES as readonly string[]).includes(params.get('theme') ?? '') ? (params.get('theme') as BrowseTheme) : undefined,
    favorite: params.get('fav') === '1',
    sort,
    order: orderParam === 'asc' || orderParam === 'desc' ? orderParam : defaultOrder(sort),
  };
}

export function useGalleryParams() {
  const [params, setParams] = useSearchParams();
  const kindPref = usePrefs((s) => s.galleryKinds);
  const setKindPref = usePrefs((s) => s.setGalleryKinds);
  const filters = useMemo(() => parse(params, kindPref), [params, kindPref]);

  const update = useCallback(
    (patch: Partial<GalleryFilters>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const cur = parse(prev, kindPref);
          const merged = { ...cur, ...patch };
          const set = (key: string, value: string | undefined) => {
            if (value) next.set(key, value);
            else next.delete(key);
          };
          set('q', merged.q.trim() || undefined);
          // 类型：等于偏好时不写进 URL；用户换了类型就记成新偏好
          if (patch.kind !== undefined) setKindPref(merged.kind);
          set('kind', patch.kind !== undefined || sameKinds(merged.kind, kindPref) ? undefined : merged.kind === 'all' ? 'all' : merged.kind.join(','));
          set('rating', merged.rating.length ? RATINGS.filter((r) => merged.rating.includes(r)).join(',') : undefined);
          set('orient', merged.orientation);
          set('theme', merged.theme);
          set('fav', merged.favorite ? '1' : undefined);
          set('sort', merged.sort === 'addedAt' ? undefined : merged.sort);
          // 换排序时回到该排序的默认方向；方向等于默认值时不写进 URL
          const order = patch.sort && patch.order === undefined ? defaultOrder(merged.sort) : merged.order;
          set('order', order === defaultOrder(merged.sort) ? undefined : order);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, kindPref, setKindPref],
  );

  const query = useMemo<Omit<ListImagesQuery, 'cursor'>>(
    () => ({
      q: filters.q || undefined,
      kind: filters.kind === 'all' ? undefined : filters.kind,
      rating: filters.rating.length ? filters.rating : undefined,
      orientation: filters.orientation,
      theme: filters.theme,
      favorite: filters.favorite || undefined,
      sort: filters.sort,
      order: filters.sort === 'random' ? undefined : filters.order,
    }),
    [filters],
  );

  const hasFilters = !!(filters.q || filters.rating.length || filters.orientation || filters.theme || filters.favorite);

  const clearFilters = useCallback(
    () => update({ q: '', rating: [], orientation: undefined, theme: undefined, favorite: false }),
    [update],
  );

  return { filters, query, update, hasFilters, clearFilters };
}
