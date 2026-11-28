import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { othersFetching } from './useFirstWaveSettled';

/** 一个不会自己结束的请求，手动放行 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('othersFetching：除了重复组以外还有没有查询在取（首页把重复组放到最后拉）', () => {
  it('别的查询在取时是 true，都回来了变 false；重复组自己在取不算', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(othersFetching(client, 'duplicates')).toBe(false);

    const works = deferred<string[]>();
    const top = deferred<string[]>();
    const a = client.prefetchQuery({ queryKey: ['works', { sort: 'imageCount' }], queryFn: () => works.promise });
    const b = client.prefetchQuery({ queryKey: ['characters', 'top', { limit: 6 }], queryFn: () => top.promise });
    expect(othersFetching(client, 'duplicates')).toBe(true);

    works.resolve([]);
    await a;
    // 还有一个没回来
    expect(othersFetching(client, 'duplicates')).toBe(true);
    top.resolve([]);
    await b;
    expect(othersFetching(client, 'duplicates')).toBe(false);

    // 重复组自己开始取了：不算「别的」，不会把自己挡住
    const dups = deferred<unknown[]>();
    const c = client.prefetchQuery({ queryKey: ['duplicates', false], queryFn: () => dups.promise });
    expect(othersFetching(client, 'duplicates')).toBe(false);
    dups.resolve([]);
    await c;
  });
});
