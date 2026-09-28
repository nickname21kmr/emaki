import { BROWSE_THEMES, type BrowseTheme, type ImageSort, type Rating } from '@emaki/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export const SORT_OPTIONS: { value: ImageSort; label: string }[] = [
  { value: 'addedAt', label: '最近添加' },
  { value: 'modifiedAt', label: '修改时间' },
  { value: 'fileName', label: '文件名' },
  { value: 'bytes', label: '体积' },
  { value: 'random', label: '随机' },
];

export const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];

const SORTS = new Set<string>(SORT_OPTIONS.map((o) => o.value));

export type ImageOrder = 'asc' | 'desc';

export interface ImageFilters {
  sort: ImageSort;
  order: ImageOrder;
  rating: Rating[];
  /** 连漫画、截图等一起看（?kinds=all，T32a）；默认只看插画 */
  allKinds: boolean;
  /** 画面（?theme=） */
  theme: BrowseTheme | undefined;
  /** 是否是默认视图（最近添加 · 降序 · 不筛分级），用来判断「新」角标是否可信 */
  isDefault: boolean;
  setSort: (sort: ImageSort) => void;
  toggleOrder: () => void;
  toggleRating: (r: Rating) => void;
  clearRating: () => void;
  setTheme: (t: BrowseTheme | undefined) => void;
  /** 分级和画面一起清掉 */
  clearFilters: () => void;
  setAllKinds: (v: boolean) => void;
}

/**
 * 详情页插画区的排序 / 分级筛选，存在 URL 查询参数里（刷新、前进后退都保留）。
 * 默认值不写进 URL，保持地址干净。
 */
export function useImageFilters(): ImageFilters {
  const [params, setParams] = useSearchParams();

  const rawSort = params.get('sort');
  const sort: ImageSort = rawSort && SORTS.has(rawSort) ? (rawSort as ImageSort) : 'addedAt';
  const order: ImageOrder = params.get('order') === 'asc' ? 'asc' : 'desc';
  const allKinds = params.get('kinds') === 'all';
  const themeParam = params.get('theme') ?? '';
  const theme = (BROWSE_THEMES as readonly string[]).includes(themeParam) ? (themeParam as BrowseTheme) : undefined;
  const ratingParam = params.get('rating') ?? '';
  const rating = useMemo(
    () => RATINGS.filter((r) => ratingParam.split(',').includes(r)),
    [ratingParam],
  );

  const patch = useCallback(
    (entries: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(entries)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  return {
    sort,
    order,
    rating,
    allKinds,
    theme,
    isDefault: sort === 'addedAt' && order === 'desc' && rating.length === 0 && !allKinds && !theme,
    setSort: (s) => patch({ sort: s === 'addedAt' ? null : s }),
    toggleOrder: () => patch({ order: order === 'desc' ? 'asc' : null }),
    toggleRating: (r) => {
      const next = rating.includes(r) ? rating.filter((x) => x !== r) : [...rating, r];
      // 四档全选等于没筛，直接清掉
      patch({ rating: next.length === RATINGS.length ? null : next.join(',') });
    },
    clearRating: () => patch({ rating: null }),
    setTheme: (t) => patch({ theme: t ?? null }),
    clearFilters: () => patch({ rating: null, theme: null }),
    setAllKinds: (v) => patch({ kinds: v ? 'all' : null }),
  };
}
