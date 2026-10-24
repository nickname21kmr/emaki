import type { ID, ImageItem } from '@emaki/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { findCachedImage } from './cache';

/** Subscribe to metadata already in cache; no image/detail requests for every filmstrip tile. */
export function createImageCacheStore(client: QueryClient, ids: readonly ID[]) {
  const selected = new Set(ids);
  let snapshot: readonly (ImageItem | undefined)[] = [];
  const getSnapshot = () => {
    const next = ids.map(id => findCachedImage(client, id));
    if (next.length !== snapshot.length || next.some((item, i) => item !== snapshot[i])) snapshot = next;
    return snapshot;
  };
  const subscribe = (notify: () => void) => ids.length ? client.getQueryCache().subscribe(event => {
    const [family, id] = event.query.queryKey;
    if (family === 'image' ? !selected.has(id as ID) : !['images', 'unrecognized', 'duplicates'].includes(String(family))) return;
    // Observer/fetch/invalidation events don't change the displayed metadata.
    if (event.type === 'updated') {
      if (event.action.type !== 'success' && event.action.type !== 'setState') return;
    } else if (event.type !== 'removed' && !(event.type === 'added' && event.query.state.data)) return;
    const previous = snapshot;
    if (getSnapshot() !== previous) notify();
  }) : () => {};
  return { getSnapshot, subscribe };
}

export function useCachedImages(ids: readonly ID[]) {
  const client = useQueryClient();
  const store = useMemo(() => createImageCacheStore(client, ids), [client, ids]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useCachedImage(id: ID) {
  const ids = useMemo(() => [id], [id]);
  return useCachedImages(ids)[0];
}
