import type { ImageItem } from '@emaki/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, imageUrl } from '@/lib/api';
import { qk } from '@/lib/queries';
import { findCachedImage, preloadAhead, preloadNeighbors, rememberImages } from './cache';
import { createImageCacheStore } from './useCachedImages';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  rememberImages([]);
});
afterEach(() => { client.clear(); rememberImages([]); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = (id: string, modifiedAt = '2026-10-20T10:00:00Z') => ({id, modifiedAt, width: 100, height: 200}) as ImageItem;
const list = (items: ImageItem[]) => ({pages: [{items, total: items.length, nextCursor: null}], pageParams: [undefined]});

it('uses freshly fetched metadata over the slideshow snapshot, including undo to an older file timestamp', () => {
  const old = image('a'), hd = {...old, width: 1000, height: 2000, modifiedAt: '2026-10-24T10:00:00Z'};
  rememberImages([old]);
  client.setQueryData(qk.image('a'), hd, {updatedAt: 2000});
  expect(findCachedImage(client, 'a')).toBe(hd);
  client.setQueryData(qk.image('a'), old, {updatedAt: 3000});
  expect(findCachedImage(client, 'a')).toMatchObject({width: 100, modifiedAt: old.modifiedAt});
});

it('uses the latest returned list when a detail cache is older, with detail winning timestamp ties', () => {
  const old = image('a'), hd = {...old, width: 1000, modifiedAt: 'new'};
  client.setQueryData(qk.image('a'), old, {updatedAt: 1000});
  client.setQueryData(qk.images({}), list([hd]), {updatedAt: 2000});
  expect(findCachedImage(client, 'a')).toBe(hd);
  client.setQueryData(qk.image('a'), {...hd, width: 1100}, {updatedAt: 2000});
  expect(findCachedImage(client, 'a')?.width).toBe(1100);
});

it('observes replacement and undo while a filmstrip is open, without fetching all tile details', () => {
  const old = image('a'), hd = {...old, width: 1000, modifiedAt: 'new'};
  rememberImages([old]);
  const store = createImageCacheStore(client, ['a', 'unloaded']), first = store.getSnapshot();
  const notify = vi.fn(), fetch = vi.spyOn(api, 'image');
  const unsubscribe = store.subscribe(notify);
  try {
    client.setQueryData(['jobs'], []);
    expect(notify).not.toHaveBeenCalled(); expect(store.getSnapshot()).toBe(first);
    client.setQueryData(qk.image('unrelated'), image('unrelated'), {updatedAt: 2000});
    expect(notify).not.toHaveBeenCalled();
    client.setQueryData(qk.image('a'), hd, {updatedAt: 2000});
    expect(notify).toHaveBeenCalledTimes(1); expect(store.getSnapshot()[0]).toBe(hd);
    expect(store.getSnapshot()[1]).toBeUndefined();
    client.setQueryData(qk.image('a'), old, {updatedAt: 3000});
    expect(notify).toHaveBeenCalledTimes(2); expect(store.getSnapshot()[0]?.modifiedAt).toBe(old.modifiedAt);
    expect(fetch).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

it('preloads the refreshed file version while retaining thumbnail dimensions', async () => {
  const old = image('next'), hd = {...old, modifiedAt: 'new-version'};
  rememberImages([old]);
  client.setQueryData(qk.image('next'), hd, {updatedAt: 2000});
  const urls: string[] = [];
  vi.stubGlobal('Image', class { decoding = ''; set src(url: string) { urls.push(url); } });
  const fetch = vi.spyOn(api, 'image').mockResolvedValue(hd as Awaited<ReturnType<typeof api.image>>);
  preloadAhead(client, ['current', 'next'], 0);
  preloadNeighbors(client, ['current', 'next'], 0);
  expect(urls).toContain(imageUrl.thumb('next', 960, hd.modifiedAt));
  expect(urls).toContain(imageUrl.file('next', hd.modifiedAt));
  expect(urls.some(u => u.includes(encodeURIComponent(old.modifiedAt)))).toBe(false);
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled(); // Already-fresh detail data is reused.
});
