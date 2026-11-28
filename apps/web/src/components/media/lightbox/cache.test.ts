import type { ImageItem } from '@emaki/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, imageUrl } from '@/lib/api';
import { qk } from '@/lib/queries';
import { findCachedImage, HEAVY_PIXELS, preloadAhead, preloadNeighbors, preloadSettled, rememberImages, SETTLE_MS, settleTimer, wantsFull } from './cache';
import { createImageCacheStore } from './useCachedImages';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}}});
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  rememberImages([]);
});
afterEach(() => { client.clear(); rememberImages([]); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = (id: string, modifiedAt = '2026-10-20T10:00:00Z') => ({id, modifiedAt, fileVersion: `sha-${modifiedAt}`, width: 100, height: 200}) as ImageItem;
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
  const old = image('next'), hd = {...old, modifiedAt: 'new-version', fileVersion: 'sha-new-version'};
  rememberImages([old]);
  client.setQueryData(qk.image('next'), hd, {updatedAt: 2000});
  const urls = stubImage();
  const fetch = vi.spyOn(api, 'image').mockResolvedValue(hd as Awaited<ReturnType<typeof api.image>>);
  preloadAhead(client, ['current', 'next'], 0);
  preloadNeighbors(client, ['current', 'next'], 0);
  expect(urls).toContain(imageUrl.thumb('next', 960, hd.fileVersion));
  // The original waits until the viewer has settled on the current image.
  expect(urls.some(u => u.includes('/file'))).toBe(false);
  preloadSettled(client, ['current', 'next'], 0);
  expect(urls).toContain(imageUrl.file('next', hd.modifiedAt));
  expect(urls.some(u => u.includes(encodeURIComponent(old.modifiedAt)))).toBe(false);
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled(); // Already-fresh detail data is reused.
});

/** Records every address handed to `new Image().src`. */
function stubImage(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('Image', class { decoding = ''; set src(url: string) { urls.push(url); } });
  return urls;
}

it('passing an image only warms thumbnails; details are fetched just for neighbours the track cannot size yet', async () => {
  client.setQueryData(qk.images({}), list([image('p1'), image('p2'), image('p3'), image('p4')]), {updatedAt: 2000});
  const urls = stubImage();
  const fetch = vi.spyOn(api, 'image').mockImplementation(async id => image(id) as Awaited<ReturnType<typeof api.image>>);
  preloadNeighbors(client, ['p1', 'p2', 'p3', 'p4'], 1);
  expect(urls.sort()).toEqual(['p1', 'p3', 'p4'].map(id => imageUrl.thumb(id, 960, image(id).fileVersion)).sort());
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  // Members of an expanded group are in no list cache: both neighbours need their size before they can sit on the track.
  preloadNeighbors(client, ['g1', 'p2', 'g3'], 1);
  await Promise.resolve();
  expect(fetch.mock.calls.map(c => c[0]).sort()).toEqual(['g1', 'g3']);
});

it('once settled, preloads the original and details of the image ahead in the direction of travel', async () => {
  client.setQueryData(qk.images({}), list([image('s1'), image('s2'), image('s3')]), {updatedAt: 2000});
  const urls = stubImage();
  const fetch = vi.spyOn(api, 'image').mockImplementation(async id => image(id) as Awaited<ReturnType<typeof api.image>>);
  preloadSettled(client, ['s1', 's2', 's3'], 1);
  expect(urls).toEqual([imageUrl.file('s3', image('s3').modifiedAt)]);
  preloadSettled(client, ['s1', 's2', 's3'], 1, -1);
  expect(urls).toEqual([imageUrl.file('s3', image('s3').modifiedAt), imageUrl.file('s1', image('s1').modifiedAt)]);
  await Promise.resolve();
  expect(fetch.mock.calls.map(c => c[0])).toEqual(['s3', 's1']);
  // Nothing lies beyond either end of the list.
  preloadSettled(client, ['s1', 's2', 's3'], 2);
  preloadSettled(client, ['s1', 's2', 's3'], 0, -1);
  expect(urls).toHaveLength(2);
});

it('settles only after the current image has stayed put, so holding an arrow key never settles', () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  try {
    const settled = vi.fn();
    const timer = settleTimer(settled);
    for (const id of ['a', 'b', 'c', 'd']) { timer.move(id); vi.advanceTimersByTime(SETTLE_MS - 1); }
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled.mock.calls).toEqual([['d']]);
    timer.move('e'); timer.stop(); vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(settled).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('mounts originals only once settled: the current image and the one ahead, never a huge neighbour', () => {
  const pixels = 3_000_000;
  for (const offset of [-1, 0, 1]) expect(wantsFull({settled: false, offset, travel: 1, pixels})).toBe(false);
  expect([-1, 0, 1].map(offset => wantsFull({settled: true, offset, travel: 1, pixels}))).toEqual([false, true, true]);
  expect([-1, 0, 1].map(offset => wantsFull({settled: true, offset, travel: -1, pixels}))).toEqual([true, true, false]);
  expect(wantsFull({settled: true, offset: 1, travel: 1, pixels: HEAVY_PIXELS})).toBe(true);
  expect(wantsFull({settled: true, offset: 1, travel: 1, pixels: HEAVY_PIXELS + 1})).toBe(false);
  expect(wantsFull({settled: true, offset: 0, travel: 1, pixels: HEAVY_PIXELS * 4})).toBe(true);
});

it('does not rescan a large image list on every snapshot or unrelated detail update', () => {
  let reads = 0;
  const items = Array.from({length: 30000}, (_, i) => {
    const item = image(String(i));
    Object.defineProperty(item, 'id', {enumerable: true, get: () => { reads++; return String(i); }});
    return item;
  });
  client.setQueryData(qk.images({}), list(items), {updatedAt: 2000});
  const store = createImageCacheStore(client, ['29999']);
  const first = store.getSnapshot();
  const initialReads = reads;
  const notify = vi.fn(), unsubscribe = store.subscribe(notify);
  try {
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      expect(store.getSnapshot()).toBe(first);
      client.setQueryData(qk.image('unrelated'), image('unrelated'), {updatedAt: 3000 + i});
    }
    console.log(`30k-image cache: ${reads-initialReads} repeated row reads, ${(performance.now()-started).toFixed(1)} ms`);
    expect(reads).toBe(initialReads);
    expect(notify).not.toHaveBeenCalled();
  } finally {unsubscribe();}
});

it('does not inspect older list contents when the current detail is newer', () => {
  const items = [image('a')];
  client.setQueryData(qk.images({}), list(items), {updatedAt: 1000});
  const current = {...image('a'), width: 1000};
  client.setQueryData(qk.image('a'), current, {updatedAt: 2000});
  const find = vi.spyOn(items, 'find');
  expect(findCachedImage(client, 'a')).toBe(current);
  expect(find).not.toHaveBeenCalled();
});

it('refreshes memoized list hits and misses when list data changes or is removed', () => {
  const old = image('a'), hd = {...old, width: 1000, modifiedAt: 'new'};
  client.setQueryData(qk.images({}), list([old]), {updatedAt: 2000});
  const store = createImageCacheStore(client, ['a', 'b']);
  expect(store.getSnapshot()).toEqual([old, undefined]);
  const notify = vi.fn(), unsubscribe = store.subscribe(notify);
  try {
    client.invalidateQueries({queryKey: qk.images({}), refetchType: 'none'});
    expect(notify).not.toHaveBeenCalled();
    client.setQueryData(qk.images({}), list([hd, image('b')]), {updatedAt: 3000});
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()[0]?.width).toBe(1000);
    expect(store.getSnapshot()[1]?.id).toBe('b');
    client.removeQueries({queryKey: qk.images({})});
    expect(notify).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual([undefined, undefined]);
  } finally {unsubscribe();}
});

it('finds current metadata in unrecognized, duplicate and daily caches', () => {
  client.setQueryData(qk.unrecognized, {pages: [{items: [{image: image('a')}]}]}, {updatedAt: 1000});
  client.setQueryData(qk.duplicates(false), [{images: [{...image('a'), width: 200}]}], {updatedAt: 2000});
  client.setQueryData(['images', 'daily'], {...image('a'), width: 300}, {updatedAt: 3000});
  expect(findCachedImage(client, 'a')?.width).toBe(300);
  client.removeQueries({queryKey: ['images', 'daily']});
  expect(findCachedImage(client, 'a')?.width).toBe(200);
  client.removeQueries({queryKey: ['duplicates']});
  expect(findCachedImage(client, 'a')?.width).toBe(100);
});
