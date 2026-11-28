/**
 * 乐观更新：请求发出去之前，先把缓存里这几张图改成做完之后的样子，界面不用等接口和随后的整轮刷新
 * （无限列表的刷新是把已加载的每一页从头顺序取完才换数据，翻得越深等得越久）。
 *
 * 现在只有收藏：只改一个字段，结果确定，回滚简单。会让图离开列表的动作（排除、回收站、从角色移除）不在这里做。
 * 用法见 lib/queries.ts 的 useMutate({ optimistic })。
 */
import type { ID, ImageItem } from '@emaki/shared';
import type { Query, QueryClient } from '@tanstack/react-query';

export interface ImagePatch {
  favorite: boolean;
}

/** 请求失败时把改动撤回去。refetch：改回去之后要不要再向后端对一遍（缺省要） */
export type Rollback = (opts?: { refetch?: boolean }) => void;

/** 一格改动前的值；只记真的变了的字段 */
interface Before {
  favorite?: boolean;
  allFavorite?: boolean;
}

type ItemMap = (item: ImageItem) => ImageItem;

/** 列着这些图的缓存：图片列表（含首页的今日一枚）、未识别队列、「找同姿势」的列表，和这几张图各自的详情 */
const holdsImages = (key: readonly unknown[], ids: ReadonlySet<ID>): boolean =>
  key[0] === 'images' || key[0] === 'unrecognized' || (key[0] === 'pose' && key[1] === 'similar') || (key[0] === 'image' && ids.has(key[1] as ID));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isImage = (v: unknown): v is ImageItem => isRecord(v) && typeof v.id === 'string' && typeof v.favorite === 'boolean';

/** 逐项过一遍；一项都没变就还给原数组 */
function mapSame<T>(list: readonly T[], fn: (value: T) => T): readonly T[] {
  let out: T[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const next = fn(list[i]!);
    if (next !== list[i] && !out) out = list.slice();
    if (out) out[i] = next;
  }
  return out ?? list;
}

/** 列表里的一项：图片本身，或者未识别队列的 { image, suggestions } */
function mapEntry(entry: unknown, fn: ItemMap): unknown {
  if (isImage(entry)) return fn(entry);
  if (!isRecord(entry) || !isImage(entry.image)) return entry;
  const image = fn(entry.image);
  return image === entry.image ? entry : { ...entry, image };
}

/**
 * 缓存里的一份数据，里面的图各过一遍 fn：无限列表的每一页，或者单独的一张（详情、今日一枚）。
 * 没有图变了就还给原对象；没碰到的页、没碰到的项保持原来的引用
 */
export function mapCachedImages(data: unknown, fn: ItemMap): unknown {
  if (!isRecord(data) || !Array.isArray(data.pages)) return mapEntry(data, fn);
  const pages = mapSame(data.pages as unknown[], (page) => {
    if (!isRecord(page) || !Array.isArray(page.items)) return page;
    const items = mapSame(page.items as unknown[], (entry) => mapEntry(entry, fn));
    return items === page.items ? page : { ...page, items };
  });
  return pages === data.pages ? data : { ...data, pages };
}

/**
 * 一张图打上补丁，没变就还给原对象。
 * 收拢的组图格，心看的是 collectionGroup.allFavorite（这一格代表的成员全都收藏了才算）：
 * 取消收藏时成员里有一张在这次里，整格就不算了；收藏时要这一格的成员全在这次里才能断定，只收藏了其中几张的不动，等刷新。
 */
export function patchImage(item: ImageItem, ids: ReadonlySet<ID>, patch: ImagePatch, before?: Map<ID, Before>): ImageItem {
  const self = ids.has(item.id) && item.favorite !== patch.favorite;
  const g = item.collectionGroup;
  const group =
    !!g &&
    g.allFavorite !== patch.favorite &&
    g.memberIds.length > 0 &&
    (patch.favorite ? g.memberIds.every((id) => ids.has(id)) : g.memberIds.some((id) => ids.has(id)));
  if (!self && !group) return item;
  if (before && !before.has(item.id)) before.set(item.id, { ...(self && { favorite: item.favorite }), ...(group && g && { allFavorite: g.allFavorite }) });
  return {
    ...item,
    ...(self && { favorite: patch.favorite }),
    ...(group && g && { collectionGroup: { ...g, allFavorite: patch.favorite } }),
  };
}

/** 把一张图改回 before 记下的值。只改还停在这次改成的值上的：这期间落地的刷新、后来的另一次改动不去盖 */
function restoreImage(item: ImageItem, before: ReadonlyMap<ID, Before>, patch: ImagePatch): ImageItem {
  const was = before.get(item.id);
  if (!was) return item;
  const g = item.collectionGroup;
  const self = was.favorite !== undefined && item.favorite === patch.favorite;
  const group = was.allFavorite !== undefined && !!g && g.allFavorite === patch.favorite;
  if (!self && !group) return item;
  return {
    ...item,
    ...(self && { favorite: was.favorite }),
    ...(group && g && { collectionGroup: { ...g, allFavorite: was.allFavorite! } }),
  };
}

/** 一份缓存里的图过一遍 fn，变了才写回去；返回变没变 */
function write(query: Query, fn: ItemMap): boolean {
  const data = query.state.data;
  // 还没取到过的不管：没有可改的，它在途的第一次请求也不该丢
  if (data === undefined) return false;
  const next = mapCachedImages(data, fn);
  if (next === data) return false;
  // 只换 data：取到的时间、过期标记都不动。谁新谁旧（看图器的 findCachedImage）、该不该重取，都和没改过一样
  query.setState({ data: next });
  return true;
}

/**
 * 把缓存里这几张图改成 patch 的样子，返回回滚函数。同步做完：调用方（useMutate 的 onMutate）紧接着就发请求。
 * 回滚只把这次真的改过的那几格改回去（不整份盖回快照：这期间别的刷新、别的改动可能已经落地），再让碰过的缓存重新取一遍。
 */
export function patchImages(client: QueryClient, ids: readonly ID[], patch: ImagePatch): Rollback {
  const set = new Set(ids);
  const cache = client.getQueryCache();
  /** 碰过的缓存（queryHash）→ 里面每一格改动前的值 */
  const touched = new Map<string, Map<ID, Before>>();
  const unsubs: (() => void)[] = [];
  for (const query of cache.findAll({ predicate: (q) => holdsImages(q.queryKey, set) })) {
    const before = new Map<ID, Before>();
    const fn = (item: ImageItem) => patchImage(item, set, patch, before);
    if (write(query, fn)) touched.set(query.queryHash, before);
    // 在途的重取、下一页带回来的可能是改之前的值：不取消它（请求不接 signal，取消了后台照样在拉，还会再起一轮），
    // 落地后在它的结果上再打一遍补丁。这次收藏自己的刷新落地时再打一遍也没关系，值是一样的
    if (query.state.fetchStatus === 'fetching' && query.state.data !== undefined) {
      const un = cache.subscribe((e) => {
        if (e.query !== query || e.type !== 'updated' || e.action.type !== 'success') return;
        un();
        if (write(query, fn)) touched.set(query.queryHash, before);
      });
      unsubs.push(un);
    }
  }
  return ({ refetch = true } = {}) => {
    // 先摘监听，免得回滚之后落地的结果又被打回补丁
    for (const un of unsubs) un();
    for (const [hash, before] of touched) {
      const query = cache.get(hash);
      if (query) write(query, (item) => restoreImage(item, before, patch));
    }
    void client.invalidateQueries({ predicate: (q) => touched.has(q.queryHash), refetchType: refetch ? 'active' : 'none' });
  };
}
