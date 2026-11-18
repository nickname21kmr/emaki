/**
 * 合集列表、详情按需读（2026-11-18，大库上合集接口的提速）：
 * - 列表、统计只读摘要要用的东西（出场角色只算本子的：本子有没有出场角色决定待整理）；
 * - 按类型、系列、角色、作品筛选时先按索引缩小到可能命中的合集；
 * - 详情只读这一本和同系列的几本。
 * 这里在演示数据上（3 本本子、1 本画集、25 组同投稿）再加上手动关联的角色和作品、手选的组图、原创页、手动指定作品的页、
 * 达不到出场门槛的角色，逐本、逐个筛选比对：按需读出来的结果，和把全部合集连同出场角色、作品全读一遍（改之前的读法）算出来的一样。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectionKind, CollectionSummary, ListCollectionsQuery } from '@emaki/shared';
import { searchKey } from '@emaki/shared';
import { EventBus } from '../../core/events.ts';
import { openDemoEngine, type DemoEngine } from '../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { compareSummaries } from './collections.ts';

type Ranked = { id: number; pageCount: number; manual: boolean }[];
interface Full {
  row: { id: number; series_key: string | null };
  summary: CollectionSummary;
  cast: Ranked;
  works: Ranked;
}

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
let base: string;
let demo: DemoEngine;
/** 参照：全部合集连同出场角色、作品全读一遍 */
let full: Map<number, Full>;

/** 参照的列表：和 CollectionQueries.list 同一套筛选，只是在全读的结果上做 */
function expected(q: ListCollectionsQuery): CollectionSummary[] {
  const cid = q.characterId !== undefined ? Number(q.characterId) : null;
  const wid = q.workId !== undefined ? Number(q.workId) : null;
  const k = q.q ? searchKey(q.q) : '';
  const out: CollectionSummary[] = [];
  for (const l of full.values()) {
    const s = l.summary;
    if (s.pageCount === 0) continue;
    if (q.kind && s.kind !== q.kind) continue;
    if (q.seriesKey !== undefined && s.seriesKey !== q.seriesKey) continue;
    if (q.pending !== undefined && s.pending !== q.pending) continue;
    const text = [s.title ?? '', s.folderName, s.circle, s.artist, s.parody, s.translator];
    if (k && !text.some((x) => x && searchKey(x).includes(k))) continue;
    let match: number | undefined;
    if (cid !== null) {
      const hit = l.cast.find((c) => c.id === cid);
      if (!hit) continue;
      match = hit.pageCount;
    }
    if (wid !== null) {
      const hit = l.works.find((w) => w.id === wid);
      if (!hit) continue;
      match = hit.pageCount;
    }
    out.push(match === undefined ? s : { ...s, matchPageCount: match });
  }
  return out.sort(compareSummaries);
}

beforeAll(async () => {
  base = makeTmpDir('collections-scope');
  demo = await openDemoEngine(new EventBus(), { dir: path.join(base, 'demo'), memory: true, now: NOW, clock: () => NOW });
  const ds = demo.ds;
  const db = ds.ctx.db;
  const all = await ds.listCollections({});
  const books = all.filter((c) => c.membership === 'folder');
  const posts = all.filter((c) => c.membership === 'post');
  // 不在系列里的那本本子（「午后的约定」）有出场角色、没有手动关联：它待不待整理只看角色命中
  const doujin = books.find((c) => c.kind === 'doujin' && c.seriesKey === null)!;
  const artbook = books.find((c) => c.kind === 'artbook')!;
  const pagesOf = (collectionId: string, n: number) =>
    db.prepare('SELECT id FROM images WHERE collection_id = ? ORDER BY page_no LIMIT ?').pluck().all(Number(collectionId), n) as number[];

  // 一个没有任何图的角色和它的作品：只经手动关联出现在合集里（手动的不看门槛，手动角色的作品也算手动的作品）
  const insert = (sql: string) => Number(db.prepare(sql).run().lastInsertRowid);
  const lonelyWork = insert("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('只在手动关联里', 'test_lonely', '2026-01-01')");
  const lonely = insert(
    "INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES ('手动角色', 'test_lonely', 'custom', '2026-01-01')",
  );
  db.prepare('INSERT INTO character_works (character_id, work_id, position) VALUES (?, ?, 0)').run(lonely, lonelyWork);
  await ds.bulkCollections({ ids: [posts[0]!.id], action: { type: 'addCharacter', characterId: String(lonely) } });
  await ds.bulkCollections({ ids: [artbook.id], action: { type: 'addWork', workId: String(lonelyWork) } });
  await ds.bulkCollections({ ids: [posts[2]!.id], action: { type: 'review' } });
  // 手选的组图：从两组同投稿各挑几张
  const picked = [...pagesOf(posts[3]!.id, 2), ...pagesOf(posts[4]!.id, 1)].map(String);
  await ds.createCollection({ kind: 'group', title: '手选', imageIds: picked });

  // 本子里只出现在一页的角色（达不到门槛 max(2, 10%)：按角色筛选的候选里有它，但不算出场）
  const once = db
    .prepare(
      `SELECT id FROM characters WHERE id NOT IN (SELECT ic.character_id FROM image_characters ic JOIN images i ON i.id = ic.image_id
         WHERE i.collection_id = ?) ORDER BY id LIMIT 1 OFFSET 3`,
    )
    .pluck()
    .get(Number(doujin.id)) as number;
  db.prepare(
    "INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', '2026-11-01')",
  ).run(pagesOf(doujin.id, 1)[0], once);
  // 原创页（「原创」作品经 original_at 派生）和手动指定作品的页
  if (!db.prepare("SELECT 1 FROM works WHERE danbooru_tag = 'original'").get()) {
    insert("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('原创', 'original', '2026-01-01')");
  }
  const [originalPage, manualWorkPage] = pagesOf(posts[5]!.id, 2);
  db.prepare(
    "UPDATE images SET original_at = '2026-11-01', original_decision = 'manual', original_actor = 'user' WHERE id = ?",
  ).run(originalPage);
  db.prepare('INSERT INTO image_copyrights (image_id, work_id) VALUES (?, ?)').run(manualWorkPage, lonelyWork);

  // 改之前的读法：全部合集连同出场角色、作品（loadAll 是私有的，这里直接调）
  const cq = ds.collectionQueries as unknown as { loadAll(scope: { cast: boolean; works: boolean }): Map<number, Full> };
  full = cq.loadAll({ cast: true, works: true });
}, 60_000);

afterAll(async () => {
  await demo.ds.close();
  rmSync(base, { recursive: true, force: true });
});

describe('合集按需读：和全读一遍的结果一样', () => {
  it('夹具里各种情况都有', () => {
    const kinds = new Set([...full.values()].map((l) => l.summary.kind));
    expect([...kinds].sort()).toEqual(['artbook', 'doujin', 'group']);
    expect([...full.values()].some((l) => l.cast.some((c) => c.manual))).toBe(true);
    expect([...full.values()].some((l) => l.works.some((w) => w.manual))).toBe(true);
    expect([...full.values()].some((l) => l.summary.pending)).toBe(true);
    // 本子待不待整理只看出场角色的：有出场角色、没有手动关联、没标已整理，所以不待整理
    const doujin = [...full.values()].filter((l) => l.summary.kind === 'doujin' && l.cast.length && !l.summary.pending);
    expect(doujin.some((l) => l.cast.every((c) => !c.manual) && l.works.every((w) => !w.manual))).toBe(true);
    expect([...full.values()].some((l) => l.row.series_key !== null)).toBe(true);
    expect([...full.values()].filter((l) => l.summary.membership === 'selection')).toHaveLength(1);
  });

  it('列表（不筛选）、统计', async () => {
    const list = await demo.ds.listCollections({});
    expect(list).toEqual(expected({}));
    expect(list.length).toBeGreaterThan(25);
    const counts: Record<CollectionKind, number> = { doujin: 0, artbook: 0, group: 0 };
    const pending = new Set<string>();
    for (const s of list) {
      counts[s.kind]++;
      if (s.pending) pending.add(s.seriesKey ?? `c${s.id}`);
    }
    expect(demo.ds.collectionQueries.stats()).toEqual({ collectionCounts: counts, pendingCollectionCount: pending.size });
  });

  it('每本的详情：摘要、出场角色、作品、同系列', async () => {
    for (const [id, l] of full) {
      const got = (await demo.ds.getCollection(String(id)))!;
      expect(got.collection).toEqual(l.summary);
      const ranked = (xs: Ranked) => xs.map((x) => [x.id, x.pageCount, x.manual]);
      expect(got.cast.map((c) => [Number(c.character.id), c.pageCount, c.manual])).toEqual(ranked(l.cast));
      expect(got.works.map((w) => [Number(w.work.id), w.pageCount, w.manual])).toEqual(ranked(l.works));
      const series = l.row.series_key
        ? [...full.values()]
            .filter((x) => x.row.series_key === l.row.series_key && x.summary.pageCount > 0)
            .map((x) => x.summary)
            .sort((a, b) => (a.volumeNo ?? 0) - (b.volumeNo ?? 0) || Number(a.id) - Number(b.id))
        : [];
      expect(got.series).toEqual(series);
    }
    expect(await demo.ds.getCollection('999999')).toBeNull();
  });

  it('按角色、作品筛选（含手动关联、手动关联的角色的作品、达不到门槛的、原创页和手动指定的作品）', async () => {
    const db = demo.ds.ctx.db;
    const characters = db.prepare('SELECT id FROM characters ORDER BY id').pluck().all() as number[];
    const works = db.prepare('SELECT id FROM works ORDER BY id').pluck().all() as number[];
    let matched = 0;
    for (const c of characters) {
      const got = await demo.ds.listCollections({ characterId: String(c) });
      expect(got, `角色 ${c}`).toEqual(expected({ characterId: String(c) }));
      matched += got.length;
    }
    for (const w of works) {
      const got = await demo.ds.listCollections({ workId: String(w) });
      expect(got, `作品 ${w}`).toEqual(expected({ workId: String(w) }));
      matched += got.length;
    }
    expect(matched).toBeGreaterThan(30);
  });

  it('按类型、系列、待整理、搜索筛选，和几个条件一起', async () => {
    const queries: ListCollectionsQuery[] = [{ kind: 'doujin' }, { kind: 'artbook' }, { kind: 'group' }];
    queries.push({ pending: true }, { pending: false });
    for (const l of full.values()) if (l.summary.seriesKey) queries.push({ seriesKey: l.summary.seriesKey });
    queries.push({ seriesKey: '没有这个系列' }, { q: '示例' });
    const someCast = [...full.values()].find((l) => l.summary.kind === 'doujin' && l.cast.length)!;
    const someWork = [...full.values()].find((l) => l.works.length)!;
    queries.push(
      { characterId: String(someCast.cast[0]!.id), kind: 'doujin' },
      { characterId: String(someCast.cast[0]!.id), kind: 'group' },
      { workId: String(someWork.works[0]!.id), pending: false },
      { characterId: String(someCast.cast[0]!.id), workId: String(someWork.works[0]!.id) },
    );
    for (const q of queries) expect(await demo.ds.listCollections(q), JSON.stringify(q)).toEqual(expected(q));
  });
});
