import {
  BROWSE_THEMES,
  CONTENT_KINDS,
  CUSTOM_THEME_LIMITS,
  type BrowseTheme,
  type ContentKind,
  type ImageSort,
  type ListImagesQuery,
  type Rating,
} from '@emaki/shared';
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { themeQuery } from '@/lib/customTheme';
import { useCustomThemes } from '@/lib/queries';
import { usePrefs } from '@/lib/stores';
import { withParam } from '@/lib/urlPrefs';
import { usePoseEnabled } from '@/features/pose/client';

/**
 * 图库的筛选状态全部放在 URL 里（?q= &tags= &kind= &anim= &rating= &orient= &fav= &sort= &order=），
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
  /** 必含的一般标签（?tags=a,b），搜索框「按标签」和 ⌘K 的标签加进来；和自定义画面的必含合在一起查 */
  tags: string[];
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
  /** 姿势类别（?poseClass=full_01）：姿势检索打开时才生效 */
  poseClass: string | undefined;
  /** 按和这张图的姿势相近排（?poseLike=图片 id，「找同姿势的图」）；改别的筛选、排序时去掉，只留类别 */
  poseLike: string | undefined;
  /** 选了姿势类别、URL 里没写排序：按离这一类代表姿势的距离排（最典型的在前），不发 sort */
  poseOrder: boolean;
  sort: GallerySort;
  order: SortOrder;
}

/** 自定义画面的必含 + URL 里的标签，去重；接口一组最多 CUSTOM_THEME_LIMITS.tags 个 */
export function mergeTags(...lists: (readonly string[] | undefined)[]): string[] | undefined {
  const all = [...new Set(lists.flatMap((l) => l ?? []))].slice(0, CUSTOM_THEME_LIMITS.tags);
  return all.length ? all : undefined;
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

const POSE_CLASS_RE = /^[a-z]+_\d{1,3}$/;

export function parseGalleryParams(params: URLSearchParams, kindFallback: ContentKind[] | 'all'): GalleryFilters {
  const ratingSet = new Set((params.get('rating') ?? '').split(','));
  const orient = params.get('orient');
  const sortParam = params.get('sort');
  const sortGiven = SORTS.includes(sortParam as GallerySort);
  const sort = sortGiven ? (sortParam as GallerySort) : 'addedAt';
  const orderParam = params.get('order');
  const poseClass = POSE_CLASS_RE.test(params.get('poseClass') ?? '') ? params.get('poseClass')! : undefined;
  return {
    q: params.get('q') ?? '',
    tags: [...new Set((params.get('tags') ?? '').split(',').filter(Boolean))],
    kind: parseKind(params.get('kind'), kindFallback),
    animated: params.get('anim') === '1',
    // 按固定顺序输出，保证 query key 稳定
    rating: RATINGS.filter((r) => ratingSet.has(r)),
    orientation: ORIENTATIONS.includes(orient as Orientation) ? (orient as Orientation) : undefined,
    theme: (BROWSE_THEMES as readonly string[]).includes(params.get('theme') ?? '') ? (params.get('theme') as BrowseTheme) : undefined,
    custom: params.get('custom') || undefined,
    favorite: params.get('fav') === '1',
    artist: params.get('artist') || undefined,
    poseClass,
    poseLike: (poseClass && params.get('poseLike')) || undefined,
    poseOrder: !!poseClass && !sortGiven,
    sort,
    order: orderParam === 'asc' || orderParam === 'desc' ? orderParam : defaultOrder(sort),
  };
}

/** 把一次修改写回 URL 参数（纯函数，测试直接用）。writeKind：这一页管类型，或者这次改了类型 */
export function applyGalleryPatch(
  prev: URLSearchParams,
  patch: Partial<GalleryFilters>,
  kindPref: ContentKind[] | 'all',
  writeKind: boolean,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  const cur = parseGalleryParams(prev, kindPref);
  const merged = { ...cur, ...patch };
  // 内置画面和自定义画面只能选一个
  if (patch.theme) merged.custom = undefined;
  if (patch.custom) merged.theme = undefined;
  // 姿势：「找同姿势的图」的排法只在没动别的时保留；换了类别默认按典型度排，明确选了排序就按那个
  if (!('poseLike' in patch)) merged.poseLike = undefined;
  if (!merged.poseClass) merged.poseLike = undefined;
  if (patch.poseOrder === undefined) {
    if (patch.sort !== undefined) merged.poseOrder = false;
    else if (patch.poseClass && patch.poseClass !== cur.poseClass) merged.poseOrder = true;
  }
  if (!merged.poseClass) merged.poseOrder = false;
  const set = (key: string, value: string | undefined) => {
    if (value) next.set(key, value);
    else next.delete(key);
  };
  set('q', merged.q.trim() || undefined);
  set('tags', merged.tags.length ? [...new Set(merged.tags)].slice(0, CUSTOM_THEME_LIMITS.tags).join(',') : undefined);
  // 类型：一直写在 URL 里
  if (writeKind) set('kind', kindParam(merged.kind));
  set('anim', merged.animated ? '1' : undefined);
  set('rating', merged.rating.length ? RATINGS.filter((r) => merged.rating.includes(r)).join(',') : undefined);
  set('orient', merged.orientation);
  set('theme', merged.theme);
  set('custom', merged.custom);
  set('fav', merged.favorite ? '1' : undefined);
  set('artist', merged.artist);
  set('poseClass', merged.poseClass);
  set('poseLike', merged.poseLike);
  if (merged.poseOrder) {
    // 按典型度排没有方向
    next.delete('sort');
    next.delete('order');
    return next;
  }
  // 选着姿势类别时「最近添加」也要写出来，不然读回来又成了按典型度
  set('sort', merged.sort === 'addedAt' && !merged.poseClass ? undefined : merged.sort);
  // 换排序时回到该排序的默认方向；方向等于默认值时不写进 URL
  const order = patch.sort && patch.order === undefined ? defaultOrder(merged.sort) : merged.order;
  set('order', order === defaultOrder(merged.sort) ? undefined : order);
  return next;
}

/** 姿势检索关着时去掉姿势参数（URL 里留着，打开后还能用） */
export function gatePose(f: GalleryFilters, poseOn: boolean): GalleryFilters {
  return poseOn ? f : { ...f, poseClass: undefined, poseLike: undefined, poseOrder: false };
}

/** ownsKind：类型由这一页决定（图库）。别册页的类型来自路由，不把图库的类型偏好补进 URL */
export function useGalleryParams({ ownsKind = true }: { ownsKind?: boolean } = {}) {
  const [params, setParams] = useSearchParams();
  const storedKinds = usePrefs((s) => s.galleryKinds);
  const kindPref = useMemo(() => validKinds(storedKinds), [storedKinds]);
  const setKindPref = usePrefs((s) => s.setGalleryKinds);
  // 姿势检索关着时 URL 里的姿势参数当没写（接口会 403）
  const poseOn = usePoseEnabled();
  const filters = useMemo(() => gatePose(parseGalleryParams(params, kindPref), poseOn), [params, kindPref, poseOn]);

  const update = useCallback(
    (patch: Partial<GalleryFilters>) => {
      // 用户换了类型就记成新偏好
      if (patch.kind !== undefined) setKindPref(patch.kind);
      setParams((prev) => applyGalleryPatch(prev, patch, kindPref, ownsKind || patch.kind !== undefined), { replace: true });
    },
    [setParams, kindPref, setKindPref, ownsKind],
  );

  // URL 里还没写类型（从侧栏点进来）：把偏好补进去，不多一条历史
  const kindMissing = ownsKind && params.get('kind') === null;
  useEffect(() => {
    if (!kindMissing) return;
    setParams((prev) => (prev.get('kind') !== null ? prev : withParam(prev, 'kind', kindParam(kindPref))), { replace: true });
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
      tagsAll: mergeTags(customTags.tagsAll, filters.tags),
      favorite: filters.favorite || undefined,
      artist: filters.artist,
      poseClass: filters.poseClass,
      // 按姿势典型度排时不发排序（服务端默认按距离）
      sort: filters.poseOrder ? undefined : filters.sort,
      order: filters.poseOrder || filters.sort === 'random' ? undefined : filters.order,
    }),
    [filters, customTags],
  );

  const hasFilters = !!(
    filters.q ||
    filters.tags.length ||
    filters.animated ||
    filters.rating.length ||
    filters.orientation ||
    filters.theme ||
    customTheme ||
    filters.favorite ||
    filters.artist ||
    filters.poseClass
  );

  const clearFilters = useCallback(
    () =>
      update({
        q: '',
        tags: [],
        animated: false,
        rating: [],
        orientation: undefined,
        theme: undefined,
        custom: undefined,
        favorite: false,
        artist: undefined,
        poseClass: undefined,
        poseLike: undefined,
      }),
    [update],
  );

  return { filters, query, update, hasFilters, clearFilters, customThemes };
}
