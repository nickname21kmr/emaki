import { notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useSyncExternalStore } from 'react';

/** 除了第一段是 except 的查询以外，现在还有没有查询在取 */
export const othersFetching = (client: QueryClient, except: string): boolean =>
  client.isFetching({ predicate: (q) => q.queryKey[0] !== except }) > 0;

/**
 * 首屏那一波查询回来了没有：ready（调用方自己的几个查询都回来了）而且除了 except 以外没有查询在取时变成 true，之后一直是 true。
 * 首页用它把重复组（真实库 700 多 KB）放到最后拉：后端一次只处理一个请求，大的和别的一起发，几毫秒就能回来的小请求都得排在它后面。
 * ready 管的是刚挂上的那一刻：这时别的查询还没开始取，光看「没有在取的」会误以为已经回来了。
 * 变成 true 之后不再看查询缓存，别的查询之后来回刷新不会让调用方重渲染
 */
export function useFirstWaveSettled(ready: boolean, except: string): boolean {
  const client = useQueryClient();
  const settled = useRef(false);
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [client],
  );
  const read = () => {
    if (!settled.current && ready && !othersFetching(client, except)) settled.current = true;
    return settled.current;
  };
  return useSyncExternalStore(subscribe, read, read);
}
