import type { ImageItem } from '@emaki/shared';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapCachedImages, patchImage, patchImages } from './optimisticImages';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => client.clear());

const image = (id: string, favorite = false) => ({ id, favorite, fileName: `${id}.png` }) as ImageItem;
/** 收拢的组图格：封面是 id，背后是 members */
const group = (id: string, members: string[], allFavorite: boolean, favorite = false) =>
  ({ ...image(id, favorite), collectionGroup: { id: `g-${id}`, title: null, kind: 'group', count: members.length, total: members.length, allFavorite, memberIds: members } }) as ImageItem;
type List = InfiniteData<{ items: ImageItem[]; total: number; nextCursor: string | null }>;
const list = (...pages: ImageItem[][]): List => ({
  pages: pages.map((items, i) => ({ items, total: 99, nextCursor: i < pages.length - 1 ? `c${i}` : null })),
  pageParams: pages.map((_, i) => (i ? `c${i - 1}` : undefined)),
});
const KEY = ['images', { sort: 'added' }];
const items = (key: readonly unknown[] = KEY) => client.getQueryData<List>(key)!.pages.flatMap((p) => p.items);
const fav = (key: readonly unknown[] = KEY) => Object.fromEntries(items(key).map((i) => [i.id, i.favorite]));

describe('patchImage', () => {
  it('这次里的图改收藏；别的图、值本来就一样的还给原对象', () => {
    const a = image('a');
    expect(patchImage(a, new Set(['a']), { favorite: true })).toEqual({ ...a, favorite: true });
    expect(patchImage(a, new Set(['b']), { favorite: true })).toBe(a);
    expect(patchImage(a, new Set(['a']), { favorite: false })).toBe(a);
  });

  it('收拢的组图格：成员全在这次里才算整组收藏了', () => {
    const g = group('a', ['a', 'b', 'c'], false);
    const all = patchImage(g, new Set(['a', 'b', 'c']), { favorite: true });
    expect(all.collectionGroup?.allFavorite).toBe(true);
    expect(all.favorite).toBe(true);
    // 只收藏了其中一张（看图器里按 F）：其余两张不知道，整格不动；封面自己那张照改
    const one = patchImage(g, new Set(['a']), { favorite: true });
    expect(one.collectionGroup?.allFavorite).toBe(false);
    expect(one.favorite).toBe(true);
    // 不是封面的那张：这一格什么都没变
    expect(patchImage(g, new Set(['b']), { favorite: true })).toBe(g);
  });

  it('收拢的组图格：取消其中任何一张，整组就不算收藏了', () => {
    const g = group('a', ['a', 'b', 'c'], true, true);
    const next = patchImage(g, new Set(['c']), { favorite: false });
    expect(next.collectionGroup?.allFavorite).toBe(false);
    expect(next.favorite).toBe(true);
    expect(patchImage(g, new Set(['x']), { favorite: false })).toBe(g);
  });
});

describe('mapCachedImages', () => {
  it('没碰到的页、没碰到的项保持原引用；一张都没变还给原对象', () => {
    const data = list([image('a'), image('b')], [image('c'), image('d')]);
    const next = mapCachedImages(data, (i) => (i.id === 'c' ? { ...i, favorite: true } : i)) as List;
    expect(next).not.toBe(data);
    expect(next.pageParams).toBe(data.pageParams);
    expect(next.pages[0]).toBe(data.pages[0]);
    expect(next.pages[1]).not.toBe(data.pages[1]);
    expect(next.pages[1]!.items[1]).toBe(data.pages[1]!.items[1]);
    expect(next.pages[1]!.items[0]).toMatchObject({ id: 'c', favorite: true });
    expect(next.pages[1]!.total).toBe(99);
    expect(mapCachedImages(data, (i) => i)).toBe(data);
  });

  it('不是图片的数据原样还回去', () => {
    const fn = (i: ImageItem) => ({ ...i, favorite: true });
    const summary = { total: 3, art: 2 };
    expect(mapCachedImages(summary, fn)).toBe(summary);
    expect(mapCachedImages(null, fn)).toBe(null);
    expect(mapCachedImages(7, fn)).toBe(7);
    const groups = [{ images: [image('a')] }];
    expect(mapCachedImages(groups, fn)).toBe(groups);
  });
});

describe('patchImages', () => {
  it('图片列表里那一页的那一张、这张的详情、今日一枚、未识别队列、同姿势列表都改到', () => {
    client.setQueryData(KEY, list([image('a'), image('b')], [image('c')]));
    client.setQueryData(['image', 'c'], image('c'));
    client.setQueryData(['image', 'b'], image('b'));
    client.setQueryData(['images', 'daily', 1, true], image('c'));
    client.setQueryData(['unrecognized', 'art'], { pages: [{ items: [{ image: image('c'), suggestions: [] }, { image: image('z'), suggestions: [] }] }], pageParams: [undefined] });
    client.setQueryData(['pose', 'similar', 'x'], list([image('c')]));
    client.setQueryData(['unrecognized', 'summary'], { total: 2 });
    const before = client.getQueryData<List>(KEY)!;

    patchImages(client, ['c'], { favorite: true });

    expect(fav()).toEqual({ a: false, b: false, c: true });
    expect(client.getQueryData<List>(KEY)!.pages[0]).toBe(before.pages[0]);
    expect(client.getQueryData<ImageItem>(['image', 'c'])!.favorite).toBe(true);
    expect(client.getQueryData<ImageItem>(['image', 'b'])!.favorite).toBe(false);
    expect(client.getQueryData<ImageItem>(['images', 'daily', 1, true])!.favorite).toBe(true);
    const queue = client.getQueryData<{ pages: { items: { image: ImageItem }[] }[] }>(['unrecognized', 'art'])!.pages[0]!.items;
    expect(queue.map((it) => it.image.favorite)).toEqual([true, false]);
    expect(fav(['pose', 'similar', 'x'])).toEqual({ c: true });
    expect(client.getQueryData(['unrecognized', 'summary'])).toEqual({ total: 2 });
  });

  it('网格上点收拢的组图格：成员全改，整格的心跟着变', () => {
    client.setQueryData(KEY, list([group('a', ['a', 'b'], false), image('x')]));
    patchImages(client, ['a', 'b'], { favorite: true });
    expect(items()[0]).toMatchObject({ favorite: true, collectionGroup: { allFavorite: true } });
    patchImages(client, ['b'], { favorite: false });
    expect(items()[0]).toMatchObject({ favorite: true, collectionGroup: { allFavorite: false } });
  });

  it('只换数据：取到的时间、过期标记不动（谁新谁旧、该不该重取都和没改过一样）', () => {
    client.setQueryData(KEY, list([image('a')]), { updatedAt: 1000 });
    client.setQueryData(['image', 'a'], image('a'), { updatedAt: 2000 });
    void client.invalidateQueries({ queryKey: KEY, refetchType: 'none' });
    patchImages(client, ['a'], { favorite: true });
    expect(client.getQueryState(KEY)).toMatchObject({ dataUpdatedAt: 1000, isInvalidated: true });
    expect(client.getQueryState(['image', 'a'])).toMatchObject({ dataUpdatedAt: 2000, isInvalidated: false });
  });

  it('缓存里没有这几张图的不碰', () => {
    client.setQueryData(KEY, list([image('a')]));
    const data = client.getQueryData(KEY);
    patchImages(client, ['nope'], { favorite: true });
    expect(client.getQueryData(KEY)).toBe(data);
  });

  it('回滚只还原这几张，没碰的项引用不变', () => {
    client.setQueryData(KEY, list([image('a'), image('b', true)], [image('c')]));
    const b = items()[1];
    const rollback = patchImages(client, ['a', 'c'], { favorite: true });
    expect(fav()).toEqual({ a: true, b: true, c: true });
    rollback();
    expect(fav()).toEqual({ a: false, b: true, c: false });
    expect(items()[1]).toBe(b);
  });

  it('回滚把整组的心也改回去', () => {
    client.setQueryData(KEY, list([group('a', ['a', 'b'], false)]));
    const rollback = patchImages(client, ['a', 'b'], { favorite: true });
    expect(items()[0]!.collectionGroup!.allFavorite).toBe(true);
    rollback();
    expect(items()[0]).toMatchObject({ favorite: false, collectionGroup: { allFavorite: false } });
  });

  it('连打两次补丁，回滚第一次不盖第二次', () => {
    client.setQueryData(KEY, list([image('a'), image('b')]));
    const first = patchImages(client, ['a'], { favorite: true });
    patchImages(client, ['b'], { favorite: true });
    first();
    expect(fav()).toEqual({ a: false, b: true });
  });

  it('同一张连着改两次（收藏又取消），回滚第一次不把第二次的值盖掉', () => {
    client.setQueryData(KEY, list([image('a')]));
    const first = patchImages(client, ['a'], { favorite: true });
    patchImages(client, ['a'], { favorite: false });
    first();
    expect(fav()).toEqual({ a: false });
  });

  it('这期间刷新已经落地（值变了）的不去盖', () => {
    client.setQueryData(KEY, list([image('a'), image('b')]));
    const rollback = patchImages(client, ['a', 'b'], { favorite: true });
    // 刷新带回来的：a 在服务端还是没收藏，b 是收藏的（比如别处收藏的）
    client.setQueryData(KEY, list([image('a', false), image('b', true)]));
    const a = items()[0];
    rollback();
    expect(items()[0]).toBe(a);
    // b 还停在这次改成的值上，照回滚处理；随后的重取以服务端为准
    expect(fav()).toEqual({ a: false, b: false });
  });

  it('回滚后碰过的缓存标记过期；refetch: false 时只标记', () => {
    client.setQueryData(KEY, list([image('a')]));
    client.setQueryData(['images', { sort: 'name' }], list([image('z')]));
    const rollback = patchImages(client, ['a'], { favorite: true });
    rollback({ refetch: false });
    expect(client.getQueryState(KEY)!.isInvalidated).toBe(true);
    expect(client.getQueryState(['images', { sort: 'name' }])!.isInvalidated).toBe(false);
  });

  it('在途的重取带回来的旧值不会盖掉改动；查询不进错误状态', async () => {
    client.setQueryData(KEY, list([image('a')]));
    let land!: (v: List) => void;
    const refetch = client.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<List>((r) => (land = r)), staleTime: 0 });
    await Promise.resolve();
    expect(client.getQueryState(KEY)!.fetchStatus).toBe('fetching');

    patchImages(client, ['a'], { favorite: true });
    // 不取消在途的重取（请求停不下来，取消了只会再起一轮），它落地后再打一遍补丁
    expect(client.getQueryState(KEY)).toMatchObject({ fetchStatus: 'fetching', status: 'success' });
    expect(fav()).toEqual({ a: true });
    land(list([image('a', false)]));
    await refetch;
    expect(fav()).toEqual({ a: true });
    expect(client.getQueryState(KEY)).toMatchObject({ status: 'success', error: null });
  });

  it('还没取到过的查询不管：它的第一次请求照常落地', async () => {
    let land!: (v: List) => void;
    const first = client.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<List>((r) => (land = r)) });
    await Promise.resolve();
    patchImages(client, ['a'], { favorite: true });
    expect(client.getQueryState(KEY)!.fetchStatus).toBe('fetching');
    land(list([image('a', false)]));
    await first;
    expect(fav()).toEqual({ a: false });
  });
});
