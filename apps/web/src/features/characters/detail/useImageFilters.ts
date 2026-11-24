import { BROWSE_THEMES, LIST_SORTS, SORT_LABELS, type BrowseTheme, type CustomTheme, type ImageSort, type Rating } from '@emaki/shared';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useOverride } from '@/lib/plugins';
import { useCustomThemes } from '@/lib/queries';

export const SORT_OPTIONS: { value: ImageSort; label: string }[] = LIST_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }));

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
  /** 自定义画面（?custom=，和 theme 互斥）；id 找不到时为 undefined */
  custom: CustomTheme | undefined;
  /** 全部自定义画面，给菜单列出来 */
  customThemes: CustomTheme[];
  /** 是否是默认视图（最近添加 · 降序 · 不筛分级），用来判断「新」角标是否可信 */
  isDefault: boolean;
  setSort: (sort: ImageSort) => void;
  toggleOrder: () => void;
  toggleRating: (r: Rating) => void;
  clearRating: () => void;
  setTheme: (t: BrowseTheme | undefined) => void;
  setCustom: (id: string | undefined) => void;
  /** 内置和自定义画面都清掉 */
  clearTheme: () => void;
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
  // 没写排序时按生效的默认排序（插件能覆盖，docs/plugins.md 9.5）
  const defaultSort = useOverride('images.defaultSort');
  const sort: ImageSort = rawSort && SORTS.has(rawSort) ? (rawSort as ImageSort) : defaultSort;
  const order: ImageOrder = params.get('order') === 'asc' ? 'asc' : 'desc';
  const allKinds = params.get('kinds') === 'all';
  const themeParam = params.get('theme') ?? '';
  const theme = (BROWSE_THEMES as readonly string[]).includes(themeParam) ? (themeParam as BrowseTheme) : undefined;
  const customThemes = useCustomThemes();
  const customParam = params.get('custom');
  const custom = customParam ? customThemes.find((t) => t.id === customParam) : undefined;
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
    custom,
    customThemes,
    isDefault: sort === defaultSort && order === 'desc' && rating.length === 0 && !allKinds && !theme && !custom,
    setSort: (s) => patch({ sort: s === defaultSort ? null : s }),
    toggleOrder: () => patch({ order: order === 'desc' ? 'asc' : null }),
    toggleRating: (r) => {
      const next = rating.includes(r) ? rating.filter((x) => x !== r) : [...rating, r];
      // 四档全选等于没筛，直接清掉
      patch({ rating: next.length === RATINGS.length ? null : next.join(',') });
    },
    clearRating: () => patch({ rating: null }),
    setTheme: (t) => patch({ theme: t ?? null, ...(t ? { custom: null } : {}) }),
    setCustom: (id) => patch({ custom: id ?? null, ...(id ? { theme: null } : {}) }),
    clearTheme: () => patch({ theme: null, custom: null }),
    clearFilters: () => patch({ rating: null, theme: null, custom: null }),
    setAllKinds: (v) => patch({ kinds: v ? 'all' : null }),
  };
}
