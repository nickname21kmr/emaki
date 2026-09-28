import type { DuplicateGroup, ID, ImageItem, Page, UnrecognizedItem } from '@emaki/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { api, imageUrl } from '@/lib/api';
import { qk } from '@/lib/queries';

/**
 * 看图器只拿到 id 列表。打开时先从已缓存的列表里找到这张图的基本信息（尺寸 / 主色 / 分级），
 * 这样不用等详情接口就能立刻按正确比例摆好占位，避免跳动。
 */
export function findCachedImage(client: QueryClient, id: ID): ImageItem | undefined {
  const kept = remembered.get(id);
  if (kept) return kept;
  for (const [, data] of client.getQueriesData<InfiniteData<Page<ImageItem>>>({ queryKey: ['images'] })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((i) => i.id === id);
      if (hit) return hit;
    }
  }
  for (const [, data] of client.getQueriesData<InfiniteData<Page<UnrecognizedItem>>>({ queryKey: qk.unrecognized })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((i) => i.image.id === id);
      if (hit) return hit.image;
    }
  }
  for (const [, data] of client.getQueriesData<DuplicateGroup[]>({ queryKey: ['duplicates'] })) {
    for (const group of Array.isArray(data) ? data : []) {
      const hit = group.images.find((i) => i.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

// 放映拉来的图不在任何网格的缓存里：单独记住，每次开始放映时替换
const remembered = new Map<ID, ImageItem>();

export function rememberImages(items: ImageItem[]) {
  remembered.clear();
  for (const it of items) remembered.set(it.id, it);
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
    warm(imageUrl.thumb(next, 960));
    warm(imageUrl.file(next));
    void client.prefetchQuery({ queryKey: qk.image(next), queryFn: () => api.image(next), staleTime: 30_000 });
  }
  if (prev) warm(imageUrl.thumb(prev, 960));
  if (after) warm(imageUrl.thumb(after, 960));
}

/** 等一张图解码好（失败或超时也放行），放映换片前用，避免交叉淡化时露出底色 */
export function whenDecoded(src: string, timeout = 3000): Promise<void> {
  const img = new Image();
  img.src = src;
  return Promise.race([img.decode().catch(() => {}), new Promise<void>((r) => window.setTimeout(r, timeout))]);
}

/** 放映会绕回开头：按循环取后两张，预加载 960 缩略图 */
export function preloadAhead(ids: ID[], index: number) {
  for (const k of [1, 2]) {
    if (ids.length > k) warm(imageUrl.thumb(ids[(index + k) % ids.length]!, 960));
  }
}
