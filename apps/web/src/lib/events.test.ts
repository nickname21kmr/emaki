import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvalidator, isDeepList, openEventStream } from './events';

interface Call {
  predicate: (q: { queryKey: readonly unknown[] }) => boolean;
  refetchType?: string;
}

function fakeClient() {
  const calls: Call[] = [];
  const client = {
    invalidateQueries: (f: Call) => {
      calls.push(f);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, calls };
}

/** 排名列表（作品）真的重拉了几次；只标记过期（refetchType: 'none'）的不算 */
const rankRefetches = (calls: Call[]) => calls.filter((c) => c.refetchType !== 'none' && c.predicate({ queryKey: ['works', {}] })).length;

describe('createInvalidator：识别中排名列表的节流', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 从现在起每 5 秒来一次 tag 事件，共 n 次（每次都等 400ms 的节流跑完） */
  const tagEvery5s = (invalidate: (r?: 'tag') => void, n: number) => {
    for (let i = 0; i < n; i++) {
      vi.advanceTimersByTime(4600);
      invalidate('tag');
      vi.advanceTimersByTime(400);
    }
  };

  it('识别 40 秒后没有新事件：一分钟到了补拉一次，之后不再拉', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    expect(rankRefetches(calls)).toBe(1);
    tagEvery5s(invalidate, 8);
    expect(rankRefetches(calls)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(rankRefetches(calls)).toBe(2);
    vi.advanceTimersByTime(10 * 60_000);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('最后一次事件离窗口到期很近时，至少再等 11 秒（躲过后端的软缓存）', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 11); // 最后一次在第 55.4 秒处理完，窗口第 60.4 秒到期
    vi.advanceTimersByTime(10_999);
    expect(rankRefetches(calls)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('非识别事件照常立刻刷新，待补的那次取消', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 1);
    invalidate('mutation');
    vi.advanceTimersByTime(400);
    expect(rankRefetches(calls)).toBe(2);
    vi.advanceTimersByTime(5 * 60_000);
    expect(rankRefetches(calls)).toBe(2);
    dispose();
  });

  it('dispose 后不再补拉', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag');
    vi.advanceTimersByTime(400);
    tagEvery5s(invalidate, 2);
    dispose();
    vi.advanceTimersByTime(5 * 60_000);
    expect(rankRefetches(calls)).toBe(1);
  });
});

describe('createInvalidator：后台任务写库时，翻了几页的图库 / 角色列表少重拉', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Page {
    items: number[];
    next: number | null;
  }
  /** 真 QueryClient 上挂一个已经翻了 pages 页的无限列表（有观察者，算在用）；rounds() 是整链重拉了几轮 */
  function mountList(client: QueryClient, key: unknown[], pages: number) {
    let calls = 0;
    const page = (i: number): Page => ({ items: [i], next: i + 1 < pages ? i + 1 : null });
    client.setQueryData(key, { pages: Array.from({ length: pages }, (_, i) => page(i)), pageParams: Array.from({ length: pages }, (_, i) => i) });
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: ({ pageParam }) => {
        calls++;
        return Promise.resolve(page(pageParam));
      },
      initialPageParam: 0,
      getNextPageParam: (last: Page) => last.next ?? undefined,
      staleTime: Infinity,
    });
    const off = observer.subscribe(() => {});
    return { rounds: () => calls / pages, stale: () => client.getQueryState(key)?.isInvalidated, off };
  }
  /** 普通查询（未识别列表、作品这些），fetches() 是重拉了几次 */
  function mountQuery(client: QueryClient, key: unknown[]) {
    let calls = 0;
    client.setQueryData(key, []);
    const off = new QueryObserver(client, { queryKey: key, queryFn: () => Promise.resolve([++calls]), staleTime: Infinity }).subscribe(() => {});
    return { fetches: () => calls, off };
  }
  const setup = () => {
    const client = new QueryClient();
    const { invalidate, dispose } = createInvalidator(client);
    const deep = mountList(client, ['images', { kind: ['illustration'] }], 3);
    const firstPage = mountList(client, ['images', { sort: 'addedAt' }], 1);
    const shelf = mountList(client, ['characters', { sort: 'imageCount' }], 2);
    /** 一条后台事件，等它的 400ms 节流和重拉跑完 */
    const background = async (reason: 'scan' | 'tag' = 'tag') => {
      void invalidate(reason, reason === 'scan' ? ['image.added'] : ['evidence.changed']);
      await vi.advanceTimersByTimeAsync(400);
    };
    return { client, invalidate, dispose, deep, firstPage, shelf, background };
  };

  it('isDeepList：图库、角色（不含 Top）的无限列表翻到第二页起才算', () => {
    const pages = (n: number) => ({ data: { pages: Array.from({ length: n }, () => ({})), pageParams: [] } });
    expect(isDeepList({ queryKey: ['images', {}], state: pages(2) })).toBe(true);
    expect(isDeepList({ queryKey: ['images', {}], state: pages(1) })).toBe(false);
    expect(isDeepList({ queryKey: ['characters', { sort: 'name' }], state: pages(3) })).toBe(true);
    expect(isDeepList({ queryKey: ['characters', 'top', {}], state: pages(3) })).toBe(false);
    expect(isDeepList({ queryKey: ['unrecognized', 'art'], state: pages(3) })).toBe(false);
    // 首页每日一图这种普通查询、还没取到数据的、测试里只给 queryKey 的
    expect(isDeepList({ queryKey: ['images', 'daily', 's', false], state: { data: { items: [] } } })).toBe(false);
    expect(isDeepList({ queryKey: ['images', {}], state: { data: undefined } })).toBe(false);
    expect(isDeepList({ queryKey: ['images', {}] })).toBe(false);
  });

  it('扫描 / 识别的事件：翻了 3 页的只标记过期，只有第一页的照常重拉；30 秒到了补拉一次，之后不再拉', async () => {
    const { dispose, deep, firstPage, shelf, background } = setup();
    // 头一条放行（之前没刷过）
    await background('scan');
    expect([deep.rounds(), shelf.rounds(), firstPage.rounds()]).toEqual([1, 1, 1]);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2600);
      await background(i % 2 ? 'scan' : 'tag');
    }
    // 第 15.4 秒：翻页的两个都没再拉，标着过期；第一页的每条都拉了
    expect([deep.rounds(), shelf.rounds(), firstPage.rounds()]).toEqual([1, 1, 6]);
    expect([deep.stale(), shelf.stale()]).toEqual([true, true]);
    // 上次真的刷新在第 0.4 秒，第 30.4 秒补
    await vi.advanceTimersByTimeAsync(14_999);
    expect(deep.rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect([deep.rounds(), shelf.rounds(), firstPage.rounds()]).toEqual([2, 2, 6]);
    expect(deep.stale()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect([deep.rounds(), shelf.rounds()]).toEqual([2, 2]);
    dispose();
  });

  it('任务一直在跑：大约 30 秒重拉一轮，不是每条事件一轮', async () => {
    const { dispose, deep, firstPage, background } = setup();
    await background();
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(2600);
      await background();
    }
    // 两分钟 41 条事件：第 0.4、30.4、60.4、90.4、120.4 秒各一轮
    expect(deep.rounds()).toBe(5);
    expect(firstPage.rounds()).toBe(41);
    dispose();
  });

  it('最后一条被压下的离 30 秒到期很近时，至少再等 11 秒（躲过后端的软缓存）', async () => {
    const { dispose, deep, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(25_000);
    await background(); // 第 25.8 秒处理完，窗口第 30.4 秒到期
    await vi.advanceTimersByTimeAsync(10_999);
    expect(deep.rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deep.rounds()).toBe(2);
    dispose();
  });

  it('用户的操作一律马上重拉，欠着的那次不用再补', async () => {
    const { invalidate, dispose, deep, shelf, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    expect(deep.rounds()).toBe(1);
    void invalidate('mutation', ['curation.favoriteChanged'], 'curation.setFavorite');
    await vi.advanceTimersByTimeAsync(0);
    expect([deep.rounds(), shelf.rounds()]).toEqual([2, 2]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect([deep.rounds(), shelf.rounds()]).toEqual([2, 2]);
    dispose();
  });

  it('不带变化类型的事件（任务结束兜底的那条、resync）一律全部重拉', async () => {
    const { invalidate, dispose, deep, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    void invalidate('tag');
    await vi.advanceTimersByTimeAsync(400);
    expect(deep.rounds()).toBe(2);
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    void invalidate(undefined, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(deep.rounds()).toBe(3);
    dispose();
  });

  it('用户的操作和识别事件落在同一批：按用户的操作处理，马上刷新、什么都不压', async () => {
    const { client, invalidate, dispose, deep, background } = setup();
    const triage = mountQuery(client, ['unrecognized', 'art', 'all']);
    const works = mountQuery(client, ['works', {}]);
    await background();
    expect([deep.rounds(), triage.fetches(), works.fetches()]).toEqual([1, 0, 1]);
    await vi.advanceTimersByTimeAsync(2600);
    // 用户刚点了「归入」，同一轮里紧跟着来了一条识别的事件
    let settled = false;
    void invalidate('mutation', ['curation.charactersChanged'], 'curation.link').then(() => (settled = true));
    void invalidate('tag', ['evidence.changed']);
    await vi.advanceTimersByTimeAsync(0);
    // 不等 400ms；翻页的图库、未识别列表、作品（一分钟内刚拉过）都真的重拉了
    expect([deep.rounds(), triage.fetches(), works.fetches()]).toEqual([2, 1, 2]);
    expect(settled).toBe(true);
    // 反过来（识别事件在前、用户操作在后）一样
    await vi.advanceTimersByTimeAsync(3000);
    void invalidate('tag', ['evidence.changed']);
    void invalidate('mutation', ['curation.charactersChanged'], 'curation.link');
    await vi.advanceTimersByTimeAsync(0);
    expect([deep.rounds(), triage.fetches(), works.fetches()]).toEqual([3, 2, 3]);
    dispose();
  });

  it('欠着的范围自己记着：中间翻到下一页（查询上的过期标记被清掉）也照样补', async () => {
    const { client, dispose, deep, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    expect(deep.stale()).toBe(true);
    // 取到新的一页：数据更新成功，过期标记没了
    client.setQueryData(['images', { kind: ['illustration'] }], (d: unknown) => d);
    expect(deep.stale()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deep.rounds()).toBe(2);
    dispose();
  });

  it('只刷新了一部分列表的操作（标记看过只刷角色）不取消图库欠着的那次', async () => {
    const { invalidate, dispose, deep, shelf, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    void invalidate('mutation', [], 'catalog.markSeen');
    await vi.advanceTimersByTimeAsync(0);
    expect([deep.rounds(), shelf.rounds()]).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deep.rounds()).toBe(2);
    dispose();
  });

  it('提取姿势：按姿势筛的图库翻了几页也一样缓着拉，普通图库始终不碰', async () => {
    const { client, invalidate, dispose, deep } = setup();
    const posed = mountList(client, ['images', { poseClass: 'full_03' }], 2);
    const pose = async () => {
      void invalidate('pose', ['pose.changed']);
      await vi.advanceTimersByTimeAsync(400);
    };
    await pose();
    expect(posed.rounds()).toBe(1);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2600);
      await pose();
    }
    expect(posed.rounds()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posed.rounds()).toBe(2);
    expect(deep.rounds()).toBe(0);
    dispose();
  });

  it('dispose 后不再补拉', async () => {
    const { dispose, deep, background } = setup();
    await background();
    await vi.advanceTimersByTimeAsync(2600);
    await background();
    dispose();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(deep.rounds()).toBe(1);
  });
});

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSource.all.push(this);
  }
  close() {
    this.readyState = 2;
  }
  /** 代理回了 502：EventSource 直接关掉，不会自己重连 */
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

describe('openEventStream：断了自己重连', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSource.all = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = () => {
    const on = { open: vi.fn(), message: vi.fn(), error: vi.fn() };
    const close = openEventStream(on, () => new FakeSource() as unknown as EventSource);
    return { on, close };
  };
  const last = () => FakeSource.all.at(-1)!;

  it('收到 502 关掉后退避重建，连上后退避时间复位', () => {
    const { on, close } = open();
    last().onopen?.();
    expect(on.open).toHaveBeenCalledTimes(1);
    last().onmessage?.({ data: '{"type":"stats"}' });
    expect(on.message).toHaveBeenCalledWith('{"type":"stats"}');

    last().fail();
    expect(on.error).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(2);

    // 后端还没起来：再失败一次，这回等 2 秒
    last().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(3);

    // 连上了：onopen 再跑一次（重置任务表、刷新），下次断开又从 1 秒开始
    last().onopen?.();
    expect(on.open).toHaveBeenCalledTimes(2);
    last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeSource.all).toHaveLength(4);
    close();
  });

  it('还在 CONNECTING 的错误交给浏览器自己重连', () => {
    const { close } = open();
    last().onerror?.();
    vi.advanceTimersByTime(30_000);
    expect(FakeSource.all).toHaveLength(1);
    close();
  });

  it('卸载后不再重连', () => {
    const { close } = open();
    last().fail();
    close();
    vi.advanceTimersByTime(30_000);
    expect(FakeSource.all).toHaveLength(1);
  });
});

describe('createInvalidator：提取姿势时只刷新姿势相关的查询', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pose.changed 刷新姿势查询和按姿势筛的图库，不碰普通图库、角色、作品、计数', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('pose' as never, ['pose.changed']);
    vi.advanceTimersByTime(400);
    const refreshed = (key: readonly unknown[]) => calls.some((c) => c.refetchType !== 'none' && c.predicate({ queryKey: key }));
    expect(refreshed(['pose', 'classes'])).toBe(true);
    expect(refreshed(['pose', 'similar', '7'])).toBe(true);
    expect(refreshed(['images', { kind: ['illustration'], poseClass: 'full_03' }])).toBe(true);
    expect(refreshed(['images', { kind: ['illustration'], posewearPose: 'full_single_P001' }])).toBe(true);
    expect(refreshed(['pose', 'posewear', false])).toBe(true);
    expect(refreshed(['images', { kind: ['illustration'], collapseCollections: 'auto' }])).toBe(false);
    for (const root of ['image', 'characters', 'works', 'unrecognized', 'stats', 'summary', 'collections'])
      expect(refreshed([root, {}]), root).toBe(false);
    dispose();
  });

  it('其他变化照旧按第一段刷新', () => {
    const { client, calls } = fakeClient();
    const { invalidate, dispose } = createInvalidator(client);
    invalidate('tag', ['evidence.changed']);
    vi.advanceTimersByTime(400);
    expect(calls.some((c) => c.predicate({ queryKey: ['images', { kind: ['illustration'] }] }))).toBe(true);
    dispose();
  });
});
