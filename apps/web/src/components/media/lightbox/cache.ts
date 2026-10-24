import type { DuplicateGroup, ID, ImageItem, Page, UnrecognizedItem } from '@emaki/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { api, imageUrl } from '@/lib/api';
import { qk } from '@/lib/queries';

// Query data is immutable. Reuse lookups until its array is replaced, including
// misses, so animation renders and neighboring detail requests don't rescan it.
const lookups = new WeakMap<object, Map<ID, ImageItem | undefined>>();
function findIn<T>(items: readonly T[], id: ID, imageOf: (item: T) => ImageItem): ImageItem | undefined {
  let found = lookups.get(items);
  if (!found) { found = new Map(); lookups.set(items, found); }
  if (!found.has(id)) {
    const item = items.find(item => imageOf(item).id === id);
    found.set(id, item === undefined ? undefined : imageOf(item));
  }
  return found.get(id);
}
const identity = (image: ImageItem) => image;
const unwrapped = (item: UnrecognizedItem) => item.image;

/**
 * 看图器只拿到 id 列表。打开时先从已缓存的列表里找到这张图的基本信息（尺寸 / 主色 / 分级），
 * 这样不用等详情接口就能立刻按正确比例摆好占位，避免跳动。
 */
export function findCachedImage(client: QueryClient, id: ID): ImageItem | undefined {
  const kept = remembered.get(id);
  const detail = client.getQueryState<ImageItem>(qk.image(id));
  let image = detail?.data ?? kept?.image;
  let fetchedAt = detail?.data ? detail.dataUpdatedAt : kept?.at ?? -1;
  let detailWinsTie = !!detail?.data;
  if (kept && kept.at > fetchedAt) { image = kept.image; fetchedAt = kept.at; detailWinsTie = false; }
  const consider = (candidate: ImageItem | undefined, at: number) => {
    if (candidate) { image = candidate; fetchedAt = at; detailWinsTie = false; }
  };
  for (const query of client.getQueryCache().getAll()) {
    const family = query.queryKey[0];
    if (family !== 'images' && family !== 'unrecognized' && family !== 'duplicates') continue;
    const at = query.state.dataUpdatedAt;
    // A restored original can have an older modifiedAt: use fetch time for
    // freshness. Detail wins a tie without walking older list contents first.
    if (at < fetchedAt || (at === fetchedAt && detailWinsTie)) continue;
    if (family === 'images') {
      const data = query.state.data as InfiniteData<Page<ImageItem>> | ImageItem | undefined;
      if (data && 'pages' in data) {
        for (const page of data.pages) consider(findIn(page.items, id, identity), at);
      } else if (data?.id === id) consider(data, at); // DailyPlate
    } else if (family === 'unrecognized') {
      const data = query.state.data as InfiniteData<Page<UnrecognizedItem>> | undefined;
      for (const page of data?.pages ?? []) consider(findIn(page.items, id, unwrapped), at);
    } else {
      const data = query.state.data as DuplicateGroup[] | undefined;
      for (const group of Array.isArray(data) ? data : []) consider(findIn(group.images, id, identity), at);
    }
  }
  return image;
}

// 放映拉来的图不在任何网格的缓存里：单独记住，每次开始放映时替换
const remembered = new Map<ID, {image: ImageItem; at: number}>();

export function rememberImages(items: ImageItem[]) {
  remembered.clear();
  const at = Date.now();
  for (const it of items) remembered.set(it.id, {image: it, at});
}

// 已经预加载过的地址，避免来回切换时重复创建 Image 对象
const warmed = new Set<string>();

function warm(src: string) {
  if (warmed.has(src)) return;
  warmed.add(src);
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
}

/** 预加载相邻图片：下一张的缩略图 + 原图 + 详情，上一张的缩略图 */
export function preloadNeighbors(client: QueryClient, ids: ID[], index: number) {
  const next = ids[index + 1];
  const prev = ids[index - 1];
  const after = ids[index + 2];
  if (next) {
    const version=findCachedImage(client,next)?.modifiedAt;
    warm(imageUrl.thumb(next, 960, version));
    warm(imageUrl.file(next, version));
    void client.prefetchQuery({ queryKey: qk.image(next), queryFn: () => api.image(next), staleTime: 30_000 });
  }
  if (prev) warm(imageUrl.thumb(prev, 960, findCachedImage(client,prev)?.modifiedAt));
  if (after) warm(imageUrl.thumb(after, 960, findCachedImage(client,after)?.modifiedAt));
}

/** 等一张图解码好（失败或超时也放行），放映换片前用，避免交叉淡化时露出底色 */
export function whenDecoded(src: string, timeout = 3000): Promise<void> {
  const img = new Image();
  img.src = src;
  return Promise.race([img.decode().catch(() => {}), new Promise<void>((r) => window.setTimeout(r, timeout))]);
}

/** 放映会绕回开头：按循环取后两张，预加载 960 缩略图 */
export function preloadAhead(client: QueryClient, ids: ID[], index: number) {
  for (const k of [1, 2]) {
    if (ids.length > k) {
      const id=ids[(index+k)%ids.length]!;
      warm(imageUrl.thumb(id, 960, findCachedImage(client,id)?.modifiedAt));
    }
  }
}
