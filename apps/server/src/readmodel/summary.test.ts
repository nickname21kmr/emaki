/**
 * 汇总接口和旧数字的对账（P5，附录 #28、#29）：在演示数据和契约数据上，GET /api/summary 的每个数都能逐项解释成
 * 原来的哪个数（LibraryStats、/api/unrecognized/summary）加减什么，并且和按命名口径直接数出来的一致。
 *
 * 唯一的定义（docs/core-architecture.md 第 6 节）：
 * - 待处理数 triage.total = 等你确认的张数 triage.images + 成册待整理 triage.books；不含待识别、放下的、照片 · 文字等。
 * - 已认出比例 recognition.ratio = 「插画 · 漫画」队列的范围里有角色或归原创的 / 这个范围（含放下的）。
 */
import type { LibraryStats, LibrarySummary, UnrecognizedSummary } from '@emaki/shared';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events.ts';
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import { openDemoEngine } from '../demo/engine.ts';
import { makeTmpDir } from '../../test/helpers/tmp.ts';
import { sqliteFactory, type ContractEnv } from '../../test/contract/harness.ts';
import { ART_KINDS_SQL, ART_QUEUE_SCOPE, UNRECOGNIZED } from './terms.ts';

interface Numbers {
  summary: LibrarySummary;
  stats: LibraryStats;
  unrec: UnrecognizedSummary;
  /** 直接按口径数：v_counted_images 上的条件 */
  count: (where: string) => number;
}

async function numbers(ds: SqliteDataSource): Promise<Numbers> {
  return {
    summary: await ds.getSummary(),
    stats: await ds.getStats(),
    unrec: await ds.unrecognizedSummary(),
    count: (where) => ds.ctx.db.prepare(`SELECT COUNT(*) FROM v_counted_images i WHERE ${where}`).pluck().get() as number,
  };
}

/** 逐项对账：每个数 = 旧的哪个数加减什么 */
function reconcile({ summary: s, stats, unrec, count }: Numbers): void {
  // ---- 张数
  expect(s.images.total).toBe(stats.imageCount);
  expect(s.images.illustrations).toBe(stats.kindCounts.illustration);
  // 别册 = 全部 − 插画 = 侧栏以前前端算的 annexTotal（非插画各类之和）
  expect(s.images.annex).toBe(stats.imageCount - stats.kindCounts.illustration);
  expect(s.images.annex).toBe(Object.entries(stats.kindCounts).reduce((n, [k, v]) => (k === 'illustration' ? n : n + v), 0));
  expect(s.images.byKind).toEqual(stats.kindCounts);
  expect([s.images.animated, s.images.original, s.images.bytes]).toEqual([stats.animatedCount, stats.originalCount, stats.totalBytes]);
  expect(s.images.averageBytes).toBe(stats.imageCount ? stats.totalBytes / stats.imageCount : null);
  // ---- 新收：以前首页、侧栏自己 sum(addedLast7Days)、取 [6]
  expect(s.added.last7Days).toEqual(stats.addedLast7Days);
  expect(s.added.week).toBe(stats.addedLast7Days.reduce((a, b) => a + b, 0));
  expect(s.added.today).toBe(stats.addedLast7Days[6]);
  expect(s.added.lastAt).toBe(stats.lastAddedAt);
  expect([s.characters, s.works, s.duplicates, s.customMatchable]).toEqual([
    stats.characterCount,
    stats.workCount,
    stats.duplicateGroupCount,
    stats.customMatchableCount,
  ]);

  // ---- 待处理（以前侧栏：未识别 − 待识别 + 待整理合集；首页：max(0, 未识别 − 待识别)；命令面板：未识别；服务端汇总：art.total）
  expect(s.triage.images).toBe(stats.unrecognizedCount - stats.untaggedCount);
  expect(s.triage.images).toBe(unrec.art.suggested + unrec.art.unsure);
  expect(s.triage.images).toBe(unrec.art.total - unrec.art.untagged);
  expect(s.triage.books).toBe(stats.pendingCollectionCount);
  expect(s.triage.total).toBe(s.triage.images + s.triage.books);
  expect(s.triage.total).toBe(stats.unrecognizedCount - stats.untaggedCount + stats.pendingCollectionCount);
  expect(s.triage.waiting).toBe(stats.untaggedCount);
  expect(s.triage.waiting).toBe(unrec.art.untagged);
  expect(s.triage.shelved).toBe(stats.shelvedCount);
  expect(s.triage.shelved).toBe(unrec.art.shelved);
  // 「未识别」的统计数和未识别页的「插画 · 漫画」是同一个队列
  expect(stats.unrecognizedCount).toBe(unrec.art.total);

  // ---- 已认出比例：分母和分子同一个范围
  expect(s.recognition.scope).toBe(count(ART_QUEUE_SCOPE));
  expect(s.recognition.recognized).toBe(count(`${ART_QUEUE_SCOPE} AND NOT ${UNRECOGNIZED}`));
  expect(s.recognition.recognized).toBe(s.recognition.scope - stats.unrecognizedCount - stats.shelvedCount);
  expect(s.recognition.ratio).toBe(s.recognition.scope ? s.recognition.recognized / s.recognition.scope : null);
  // 以前的分母是插画 + 漫画（全部），差的正好是不逐张找角色的：成册的页、漫画区的页、关掉设置时的漫画
  const oldDenominator = stats.kindCounts.illustration + stats.kindCounts.comic;
  expect(oldDenominator - s.recognition.scope).toBe(count(`${ART_KINDS_SQL} AND NOT (${ART_QUEUE_SCOPE})`));

  // ---- 识别进度
  expect(s.tagging.pending).toBe(stats.pendingTagCount);
  expect(s.tagging.seenRatio).toBe(stats.imageCount ? 1 - stats.pendingTagCount / stats.imageCount : null);
  expect([s.collections, s.originalWorkId, s.lastScanAt, s.recentImport]).toEqual([
    stats.collectionCounts,
    stats.originalWorkId,
    stats.lastScanAt,
    stats.recentImport,
  ]);
}

describe('汇总接口的对账：契约数据', () => {
  let env: ContractEnv;
  beforeAll(async () => {
    env = await sqliteFactory();
  });
  afterAll(() => env.close());

  it('每个数都能解释成旧数的加减，并和口径直接数的一致', async () => {
    const n = await numbers(env.ds as SqliteDataSource);
    reconcile(n);
    // 契约夹具的具体数（推算见 test/fixtures/contract-db.ts）
    expect(n.summary.triage).toMatchObject({ books: n.stats.pendingCollectionCount, waiting: n.stats.untaggedCount });
    expect(n.summary.images.total).toBe(32);
  });

  it('改了图库之后照样对得上：放下、归原创、改类型、关掉漫画设置', async () => {
    const ds = env.ds as SqliteDataSource;
    const unrec = (await ds.listUnrecognized({ area: 'art', limit: 10 })).items.map((x) => x.image.id);
    expect(unrec.length).toBeGreaterThan(2);
    await ds.bulkImages({ ids: [unrec[0]!], action: { type: 'shelve', value: true } });
    await ds.bulkImages({ ids: [unrec[1]!], action: { type: 'original', value: true } });
    await ds.bulkImages({ ids: [unrec[2]!], action: { type: 'kind', value: 'comic' } });
    reconcile(await numbers(ds));
    await ds.updateSettings({ tagger: { comicInUnrecognized: false } });
    const off = await numbers(ds);
    reconcile(off);
    // 关掉漫画设置：漫画不在分母里了
    expect(off.summary.recognition.scope).toBe(off.count(`i.content_kind = 'illustration' AND ${ART_QUEUE_SCOPE}`));
  });
});

describe('汇总接口的对账：演示数据', () => {
  const dir = makeTmpDir('summary-demo');
  let ds: SqliteDataSource;
  beforeAll(async () => {
    ({ ds } = await openDemoEngine(new EventBus(), { dir, memory: true, now: Date.parse('2026-11-18T02:13:29.069Z'), jobStepMs: 1 }));
  }, 60_000);
  afterAll(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('每个数都能解释成旧数的加减，并和口径直接数的一致', async () => {
    const n = await numbers(ds);
    reconcile(n);
    // 演示数据：侧栏「未识别」的角标和以前一样（448 张等你确认 + 2 本待整理）
    expect(n.summary.triage).toMatchObject({ images: 448, books: 2, total: 450, waiting: 140 });
  });
});
