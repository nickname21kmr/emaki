/**
 * 关键查询的固定期望结果（P1：代替以前拿 mock 和 sqlite 互相对照的 cross.test.ts）。
 * - 契约夹具：每个数字的推算见 test/fixtures/contract-db.ts 顶部注释；
 * - 演示数据（固定的「现在」）：演示模式打开时看到的统计和合集，和删掉 mock 之前大体一致（差异见各处注释）。
 * 封面具体挑哪张、颜色这类兜底选择不在这里断言。
 * 「最近 7 天新增」按本地日期分桶（产品行为如此），这里把时区固定成 UTC，固定期望才不随测试机器的时区变。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { EventBus } from '../../src/core/events.ts';
import { openDemoEngine, type DemoEngine } from '../../src/demo/engine.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { canon, sqliteFactory, type ContractEnv } from './harness.ts';

// 整个文件按 UTC 分桶：desktop 在北京时间，CI 在 UTC
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('契约夹具上的关键查询', () => {
  let env: ContractEnv;
  beforeAll(async () => {
    env = await sqliteFactory();
  });
  afterAll(() => env.close());

  it('统计', async () => {
    expect(canon(env, await env.ds.getStats())).toEqual({
      imageCount: 32,
      characterCount: 7,
      workCount: 3,
      unrecognizedCount: 7,
      duplicateGroupCount: 1,
      excludedCount: 4,
      customMatchableCount: 0,
      totalBytes: 3_200_000,
      addedLast7Days: [0, 0, 0, 8, 0, 0, 5],
      lastScanAt: '2026-09-27T10:00:00.000Z',
      untaggedCount: 1,
      shelvedCount: 0,
      recentImport: null,
      lastAddedAt: '2026-09-27T11:59:00.000Z',
      kindCounts: { illustration: 32, comic: 0, screenshot: 0, text: 0, photo: 0, meme: 0, animated: 0 },
      pendingTagCount: 1,
      collectionCounts: { doujin: 0, artbook: 0, group: 0 },
      pendingCollectionCount: 0,
      originalWorkId: null,
      originalCount: 0,
    });
  });

  it('未识别汇总', async () => {
    const none = { total: 0, suggested: 0, unsure: 0, untagged: 0, shelved: 0 };
    expect(await env.ds.unrecognizedSummary()).toEqual({
      // i24–i30：有建议 5 张（i24 i26 i27 i28 i29），没认出 1 张（i25，腿·足），没打标签 1 张（i30）
      art: {
        total: 7,
        suggested: 5,
        unsure: 1,
        untagged: 1,
        shelved: 0,
        themes: { legs: 1, chest: 0, nsfw: 0, swim: 0, kemono: 0, costume: 0, multi: 0, other: 0, comic: 0, odd: 0 },
        retaggable: 6,
        kinds: { illustration: { total: 7, suggested: 5, unsure: 1, untagged: 1, shelved: 0 }, comic: none },
      },
      annex: { total: 0, kinds: { screenshot: 0, text: 0, photo: 0, meme: 0, animated: 0 } },
    });
  });

  it('Top 角色（只按张数）和角色列表（置顶在前）', async () => {
    const top = canon(env, await env.ds.topCharacters({ limit: 9 }));
    expect(top.map((c) => [c.id, c.imageCount])).toEqual([
      ['c1', 8],
      ['c4', 6],
      ['c2', 4],
      ['c3', 3],
      ['c5', 3],
      ['c6', 2],
      ['c7', 1],
    ]);
    const list = canon(env, await env.ds.listCharacters({ limit: 200 }));
    expect({ total: list.total, otherOnlyCount: list.otherOnlyCount, nextCursor: list.nextCursor }).toEqual({ total: 7, otherOnlyCount: 0, nextCursor: null });
    // [id, 张数, 30 天内张数, +N, 置顶]
    expect(list.items.map((c) => [c.id, c.imageCount, c.recentCount, c.newCount, c.pinned])).toEqual([
      ['c3', 3, 3, 0, true],
      ['c1', 8, 6, 2, false],
      ['c4', 6, 4, 1, false],
      ['c2', 4, 2, 0, false],
      ['c5', 3, 1, 0, false],
      ['c6', 2, 1, 0, false],
      ['c7', 1, 0, 0, false],
    ]);
  });

  it('作品列表', async () => {
    const works = canon(env, await env.ds.listWorks({}));
    expect(works.map((w) => [w.id, w.name, w.imageCount, w.recentImageCount, w.characterCount])).toEqual([
      ['w1', '蔚蓝档案', 16, 11, 4],
      ['w2', '原神', 12, 6, 3],
      ['w3', '我的原创', 1, 0, 1],
    ]);
  });

  it('合集列表：夹具里没有能成册的文件夹，也没有同投稿的图', async () => {
    expect(await env.ds.listCollections({})).toEqual([]);
  });

  it('设置里的图库文件夹', async () => {
    const roots = canon(env, (await env.ds.getSettings()).libraryRoots);
    expect(roots.map((r) => [r.id, r.path, r.enabled, r.imageCount])).toEqual([
      ['root1', 'D:/Pics', true, 32],
      ['root2', 'E:/Old', false, 3],
    ]);
  });
});

describe('演示数据（演示模式打开时看到的）', () => {
  const NOW = Date.parse('2026-11-17T12:00:00.000Z');
  let base: string;
  let demo: DemoEngine;
  beforeAll(async () => {
    base = makeTmpDir('demo-snapshot');
    demo = await openDemoEngine(new EventBus(), { dir: path.join(base, 'demo'), memory: true, now: NOW, clock: () => NOW });
  }, 60_000);
  afterAll(async () => {
    await demo.ds.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('统计', async () => {
    expect(await demo.ds.getStats()).toMatchObject({
      imageCount: 8953,
      characterCount: 88,
      workCount: 23,
      unrecognizedCount: 574,
      duplicateGroupCount: 36,
      excludedCount: 176,
      untaggedCount: 135,
      pendingTagCount: 194,
      addedLast7Days: [34, 23, 14, 33, 43, 44, 48],
      kindCounts: { illustration: 6147, comic: 1122, screenshot: 698, text: 271, photo: 175, meme: 349, animated: 191 },
      // 4 本和以前一样；另外 25 组是真实规则「同一投稿自动成组」：重复组里的副本和原图来源相同（以前 mock 没有这条规则）
      collectionCounts: { doujin: 3, artbook: 1, group: 25 },
      pendingCollectionCount: 2,
    });
  });

  it('按文件夹成册的 4 本：灌进去的合集经过启动时的合集重算，标题、类型、页数、话数都保留', async () => {
    const books = (await demo.ds.listCollections({})).filter((c) => c.membership === 'folder');
    expect(books.map((c) => [c.kind, c.title, c.pageCount, c.volumeNo])).toEqual([
      ['doujin', '午后的约定', 24, null],
      ['artbook', '示例画师画集', 30, null],
      ['doujin', '示例连载', 16, 1],
      ['doujin', '示例连载', 18, 2],
    ]);
    const posts = (await demo.ds.listCollections({})).filter((c) => c.membership === 'post');
    expect(posts).toHaveLength(25);
    expect(posts.every((c) => c.kind === 'group' && c.pageCount >= 2)).toBe(true);
  });

  it('未识别汇总', async () => {
    const s = await demo.ds.unrecognizedSummary();
    expect([s.art.total, s.art.suggested, s.art.unsure, s.art.untagged]).toEqual([574, 234, 205, 135]);
    expect(s.art.kinds.comic.total).toBe(95);
    expect(s.annex).toEqual({ total: 128, kinds: { screenshot: 55, text: 19, photo: 15, meme: 25, animated: 14 } });
  });

  it('Top 角色', async () => {
    expect((await demo.ds.topCharacters({ limit: 5 })).map((c) => [c.name, c.imageCount])).toEqual([
      ['圣园未花', 744],
      ['美甘妮露', 179],
      ['老师', 175],
      ['百合园圣娅', 168],
      ['砂狼白子', 136],
    ]);
  });
});
