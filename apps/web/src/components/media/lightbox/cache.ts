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

const prefetchDetail = (client: QueryClient, id: ID) =>
  void client.prefetchQuery({ queryKey: qk.image(id), queryFn: () => api.image(id), staleTime: 30_000 });

/**
 * 每换一张就做的预加载：前后两张和下下张的 960 缩略图。
 * 前后两张摆在轨道上（lib/pager），图版要按尺寸摆：信息不在列表缓存里时（收拢的组图展开的成员）这里就去拿详情，滑过去时它已经在。
 * 原图和其余的详情等停稳了再拿（preloadSettled）
 */
export function preloadNeighbors(client: QueryClient, ids: ID[], index: number) {
  for (const id of [ids[index + 1], ids[index - 1]]) {
    if (!id) continue;
    const cached = findCachedImage(client, id);
    warm(imageUrl.thumb(id, 960, cached?.fileVersion));
    if (!cached) prefetchDetail(client, id);
  }
  const after = ids[index + 2];
  if (after) warm(imageUrl.thumb(after, 960, findCachedImage(client,after)?.fileVersion));
}

/** 换了一张以后这么久没再换，才算停稳 */
export const SETTLE_MS = 200;

/**
 * 「停稳」的计时：每换一张调一次 move(key)，之后 ms 毫秒没再换才调 onSettle(key)。
 * 按住方向键快翻时一直在换，onSettle 一次都不会来：路过的图不拉原图、不发详情请求
 */
export function settleTimer(onSettle: (key: string) => void, ms = SETTLE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  return {
    move(key: string) {
      stop();
      timer = setTimeout(() => onSettle(key), ms);
    },
    stop,
  };
}

/** 超过这么多像素的图只在当前位挂原图：解码和上传纹理的代价跟像素走，摆在旁边预解码会让翻页顿一下 */
export const HEAVY_PIXELS = 20_000_000;

/**
 * 轨道上的这一格现在要不要挂原图（挂上以后留着，由图版自己记住）。
 * 停稳以后，当前张和前进方向的那一张才挂；没停稳时谁都不挂，只放缩略图。
 * offset：相对当前张的位置（-1 / 0 / 1）；travel：最近一次往哪边翻的（-1 / 1）
 */
export function wantsFull(o: { settled: boolean; offset: number; travel: number; pixels: number }): boolean {
  if (!o.settled) return false;
  if (o.offset === 0) return true;
  return o.offset === (o.travel < 0 ? -1 : 1) && o.pixels <= HEAVY_PIXELS;
}

/**
 * 停稳以后才做的预加载：前进方向那一张的原图和详情。
 * 原图在轨道上也会挂（wantsFull）；放映时不摆前后张、超大图不在旁边挂，靠这里让字节先进浏览器缓存
 */
export function preloadSettled(client: QueryClient, ids: ID[], index: number, travel = 1) {
  const ahead = ids[index + (travel < 0 ? -1 : 1)];
  if (!ahead) return;
  warm(imageUrl.file(ahead, findCachedImage(client, ahead)?.modifiedAt));
  prefetchDetail(client, ahead);
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
      warm(imageUrl.thumb(id, 960, findCachedImage(client,id)?.fileVersion));
    }
  }
}
