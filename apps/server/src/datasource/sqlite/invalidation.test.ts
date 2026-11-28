/**
 * 缓存按变化类型失效（propagation/cacheScope.ts）：收窄了的每种操作之后，各个接口读到的要和「全部缓存清掉再读」的一样，撤销之后也是。
 * 内存库的软窗口是 0，软硬失效在这里没有区别，所以靠结果比对。
 *
 * 封面是说好的例外：收藏、分级、归类不马上重挑封面（等下一次整份重建），比对时去掉封面字段；
 * 改到现在的封面图时整份重建，连封面一起比。
 */
import type { ListImagesQuery, MutationResult, ServerEvent } from '@emaki/shared';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { runAs } from '../../propagation/actor.ts';
import { writeArtists } from '../../services/tagger/artists.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';

let env: ContractEnv;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0)) await fn();
});
const img = (id: string) => env.id('image', id);
const chr = (id: string) => env.id('character', id);
/**
 * 契约夹具，再补两样：几张图认上画师（画师列表的封面按分级挑），两张没认出的图成一组重复
 * （重复组里带着完整的图片条目，放下之后它们所在的队列会变）
 */
async function open(): Promise<SqliteDataSource> {
  env = await sqliteFactory();
  cleanup.push(() => env.close());
  const ds = env.ds as SqliteDataSource;
  const db = ds.ctx.db;
  db.transaction(() => {
    for (const [image, artist] of [['i6', 'kantoku'], ['i11', 'kantoku'], ['i18', 'mishima_kurone'], ['i25', 'mishima_kurone'], ['i30', 'kantoku']] as const)
      writeArtists(db, Number(img(image)), [[artist, 0.9]], 'x');
    db.prepare("INSERT INTO duplicate_groups (id, kind, similarity, created_at) VALUES (901, 'similar', 0.9, 'x')").run();
    db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (901, ?), (901, ?)').run(Number(img('i26')), Number(img('i28')));
  })();
  ds.ctx.invalidate();
  return ds;
}

/** 前端会读的东西全读一遍 */
async function readAll(ds: SqliteDataSource) {
  const total = async (q: ListImagesQuery) => (await ds.listImages({ ...q, limit: 1 })).total;
  return {
    summary: await ds.getSummary(),
    stats: await ds.getStats(),
    kinds: await ds.listContentKinds(),
    characters: await ds.listCharacters({ limit: 200 }),
    byNew: await ds.listCharacters({ sort: 'newCount', limit: 200 }),
    top: await ds.topCharacters({ limit: 50 }),
    works: await ds.listWorks(),
    unrecognized: await ds.unrecognizedSummary(),
    tags: await ds.tagSuggestions({ q: '' }),
    search: await ds.search({ q: 'a' }),
    searchTag: await ds.search({ q: 'girl' }),
    assign: await ds.search({ q: 'test', forAssignment: true }),
    totals: {
      all: await total({}),
      favorite: await total({ favorite: true }),
      plain: await total({ favorite: false }),
      explicit: await total({ rating: ['explicit'] }),
      general: await total({ rating: ['general'] }),
      rated: await total({ rated: true }),
      unrecognized: await total({ status: 'unrecognized' }),
      recognized: await total({ status: 'recognized' }),
      original: await total({ original: true }),
      text: await total({ q: 'mika' }),
      character: await total({ characterId: chr('c1') }),
    },
    duplicates: await ds.listDuplicates(),
    resolved: await ds.listDuplicates({ resolved: true }),
    artists: await ds.listArtists(),
  };
}

const COVER_FIELDS = new Set(['coverImageId', 'coverRating', 'coverFocus', 'coverColor', 'covers']);
function withoutCovers<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withoutCovers) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !COVER_FIELDS.has(k))
        .map(([k, x]) => [k, withoutCovers(x)]),
    ) as T;
  }
  return v;
}

/** 派生缓存整份重建了几次、现在的封面图 */
const watched = new WeakMap<object, { builds(): number; covers(): Set<number> }>();
function watchDerived(ds: SqliteDataSource) {
  const d = ds.derived as unknown as { build(now: number): unknown; track: { coverIds: Set<number> } | null };
  let w = watched.get(d);
  if (!w) {
    const build = vi.spyOn(d, 'build');
    w = {
      builds: () => build.mock.calls.length,
      covers: () => {
        ds.derived.get();
        return d.track!.coverIds;
      },
    };
    watched.set(d, w);
  }
  return w;
}

/**
 * 做一次操作，读一遍；再把缓存全清掉读一遍，两遍要一样。返回两遍之间派生缓存有没有整份重建过（操作本身引起的）。
 * covers = 封面也要一样（操作应该让派生缓存整份重建）
 */
async function sameAsFresh(ds: SqliteDataSource, op: () => Promise<unknown>, opts: { covers: boolean }): Promise<{ rebuilt: boolean }> {
  await readAll(ds);
  const w = watchDerived(ds);
  const before = w.builds();
  await op();
  const got = await readAll(ds);
  const rebuilt = w.builds() > before;
  ds.ctx.invalidate();
  const want = await readAll(ds);
  if (opts.covers) expect(got).toEqual(want);
  else expect(withoutCovers(got)).toEqual(withoutCovers(want));
  return { rebuilt };
}

describe('收窄了的操作：读到的和全部清掉再读的一样', () => {
  /** 一张不是封面的图（候选里按顺序找第一张） */
  const plain = (ds: SqliteDataSource, ...candidates: string[]) => {
    const covers = watchDerived(ds).covers();
    const hit = candidates.map(img).find((id) => !covers.has(Number(id)));
    if (!hit) throw new Error('候选都是封面图');
    return hit;
  };

  const cases: [string, (ds: SqliteDataSource) => Promise<MutationResult>][] = [
    ['收藏一张（不是封面）', (ds) => ds.bulkImages({ ids: [plain(ds, 'i5', 'i6', 'i10', 'i11')], action: { type: 'favorite', value: true } })],
    ['收藏几张（有未识别的）', (ds) => ds.bulkImages({ ids: [plain(ds, 'i5', 'i6', 'i10', 'i11'), img('i26'), img('i30')], action: { type: 'favorite', value: true } })],
    // 重复组里带着完整的图片条目
    ['收藏重复组里的图', (ds) => ds.bulkImages({ ids: [plain(ds, 'i37', 'i15'), plain(ds, 'i38', 'i20')], action: { type: 'favorite', value: true } })],
    // 没认出的图改成限制级：未识别「没认出」里它从原来的主题挪到「敏感」
    ['改分级（未识别的图）', (ds) => ds.bulkImages({ ids: [img('i25'), img('i26'), img('i30')], action: { type: 'rating', value: 'explicit' } })],
    ['改分级（角色的图，不是封面）', (ds) => ds.bulkImages({ ids: [plain(ds, 'i6', 'i11', 'i18')], action: { type: 'rating', value: 'general' } })],
    ['放下', (ds) => ds.bulkImages({ ids: [img('i26'), img('i28')], action: { type: 'shelve', value: true } })],
    ['归类（未识别的图归给角色）', (ds) => ds.bulkImages({ ids: [img('i27'), img('i30')], action: { type: 'assign', characterId: chr('c5') } })],
    ['移出角色（记否决）', (ds) => ds.bulkImages({ ids: [plain(ds, 'i10', 'i11', 'i9')], action: { type: 'unassign', characterId: chr('c2') } })],
    ['整组替换角色', (ds) => ds.updateImage(plain(ds, 'i13', 'i12'), { characterIds: [chr('c2'), chr('c5')] })],
    ['标原创', (ds) => ds.bulkImages({ ids: [img('i29'), img('i25')], action: { type: 'original', value: true } })],
    ['采纳建议（已有的角色）', (ds) => ds.acceptSuggestion(img('i28'), 'hina_(blue_archive)')],
    ['采纳建议（按标签新建角色）', (ds) => ds.acceptSuggestion(img('i27'), 'test_girl_(emaki_test)')],
    ['一次改收藏和角色', (ds) => ds.updateImage(plain(ds, 'i22', 'i21'), { characterIds: [chr('c4')], favorite: true })],
  ];

  it.each(cases)('%s，以及撤销', async (_name, run) => {
    const ds = await open();
    let result: MutationResult | undefined;
    await sameAsFresh(ds, async () => void (result = await run(ds)), { covers: false });
    await sameAsFresh(ds, () => ds.undo(result!.undoToken!), { covers: false });
  });

  it('收藏、改分级、放下不是封面的图：角色和作品不重建', async () => {
    const ds = await open();
    const id = plain(ds, 'i5', 'i6', 'i10', 'i11');
    for (const action of [
      { type: 'favorite', value: true },
      { type: 'rating', value: 'questionable' },
      { type: 'shelve', value: true },
    ] as const) {
      const { rebuilt } = await sameAsFresh(ds, () => ds.bulkImages({ ids: [id], action }), { covers: false });
      expect(rebuilt, action.type).toBe(false);
    }
  });

  it('改到现在的封面图：角色和作品整份重建，封面、封面的分级马上对', async () => {
    const ds = await open();
    // i1 是 c1 手动设的封面
    for (const action of [
      { type: 'rating', value: 'explicit' },
      { type: 'favorite', value: false },
    ] as const) {
      const { rebuilt } = await sameAsFresh(ds, () => ds.bulkImages({ ids: [img('i1')], action }), { covers: true });
      expect(rebuilt, action.type).toBe(true);
    }
    const c1 = (await ds.getCharacter(chr('c1')))!.character;
    expect(c1).toMatchObject({ coverImageId: img('i1'), coverRating: 'explicit' });
  });

  it('归类：角色和作品只重算涉及的，不整份重建；有角色从没图变成有图就整份重建', async () => {
    const ds = await open();
    const first = await sameAsFresh(ds, () => ds.bulkImages({ ids: [img('i27')], action: { type: 'assign', characterId: chr('c5') } }), { covers: false });
    expect(first.rebuilt).toBe(false);
    expect((await ds.getCharacter(chr('c5')))!.character.imageCount).toBe(4);
    // 新建一个没有图的角色（整份重建），再把图归给它：0 → 1，要挑封面
    const made = await ds.createCharacter({ name: '新来的', workIds: [] });
    await readAll(ds);
    const second = await sameAsFresh(ds, () => ds.bulkImages({ ids: [img('i30')], action: { type: 'assign', characterId: made.character.id } }), { covers: true });
    expect(second.rebuilt).toBe(true);
    expect((await ds.getCharacter(made.character.id))!.character).toMatchObject({ imageCount: 1, coverImageId: img('i30') });
  });

  it('标原创：「原创」作品已经有了的时候只重数作品，不整份重建', async () => {
    const ds = await open();
    // 第一次标原创会建「原创」作品（整份重建）
    await ds.bulkImages({ ids: [img('i29')], action: { type: 'original', value: true } });
    const originalWork = (await ds.getSummary()).originalWorkId!;
    expect((await ds.getWork(originalWork))!.imageCount).toBe(1);
    let result: MutationResult | undefined;
    const marked = await sameAsFresh(ds, async () => void (result = await ds.bulkImages({ ids: [img('i25'), img('i30')], action: { type: 'original', value: true } })), {
      covers: false,
    });
    expect(marked.rebuilt).toBe(false);
    expect((await ds.getWork(originalWork))!.imageCount).toBe(3);
    // i25 手动指定过作品 w2：归了原创就不再算 w2 的
    expect((await ds.getWork(env.id('work', 'w2')))!.imageCount).toBe(11);
    const undone = await sameAsFresh(ds, () => ds.undo(result!.undoToken!), { covers: false });
    expect(undone.rebuilt).toBe(false);
    expect((await ds.getWork(originalWork))!.imageCount).toBe(1);
    expect((await ds.getWork(env.id('work', 'w2')))!.imageCount).toBe(12);
  });

  it('不声明变化的命令（改画师的合并关系）照旧全部清空', async () => {
    const ds = await open();
    const before = await readAll(ds);
    // 绕过变更传播直接改库：只有全部清空才看得到
    ds.ctx.db.prepare("UPDATE images SET trashed_at = 'x' WHERE id = ?").run(Number(img('i2')));
    expect((await readAll(ds)).stats.imageCount).toBe(before.stats.imageCount);
    await ds.updateArtistLinks({ tags: ['mignon'], mode: 'merge', into: 'kantoku' });
    const got = await readAll(ds);
    ds.ctx.invalidate();
    expect(got).toEqual(await readAll(ds));
    expect(got.stats.imageCount).toBe(before.stats.imageCount - 1);
    expect(got.characters.items.find((c) => c.id === chr('c1'))!.imageCount).toBe(before.characters.items.find((c) => c.id === chr('c1'))!.imageCount - 1);
  });

  it('收藏之后统计、别册、未识别汇总、标签张数都还是缓存里那一份', async () => {
    const ds = await open();
    await readAll(ds);
    const refresh = vi.spyOn(ds.searchQueries, 'refreshNow');
    const kept = async () => ({ summary: await ds.getSummary(), kinds: await ds.listContentKinds(), total: (await ds.listImages({ limit: 1 })).total });
    const before = await kept();
    const unrecognized = vi.spyOn(ds.unrecognized, 'invalidate');
    await ds.bulkImages({ ids: [img('i5')], action: { type: 'favorite', value: true } });
    const after = await kept();
    expect(after.summary).toBe(before.summary);
    expect(after.kinds).toBe(before.kinds);
    expect(unrecognized).not.toHaveBeenCalled();
    await ds.tagSuggestions({ q: '' });
    expect(refresh).not.toHaveBeenCalled();
    // 放下：统计要重算，别册不用
    await ds.bulkImages({ ids: [img('i26')], action: { type: 'shelve', value: true } });
    expect(await ds.getSummary()).not.toBe(before.summary);
    expect(await ds.listContentKinds()).toBe(before.kinds);
    expect(unrecognized).toHaveBeenCalledTimes(1);
  });

  it('姿势数据变了（后台任务）：只有按姿势筛的总数失效', async () => {
    const ds = await open();
    const before = await readAll(ds);
    const w = watchDerived(ds);
    const builds = w.builds();
    const poseKey = 'count:{"poseClass":"full_01"}';
    ds.results.get(poseKey, () => 1);
    ds.results.get('count:{"favorite":true,"q":"pose"}', () => 1);
    runAs('job:pose', () => ds.ctx.apply(() => ds.ctx.changed({ type: 'pose.changed', ids: [Number(img('i1'))] })));
    expect(ds.results.get(poseKey, () => 2)).toBe(2);
    // 条件的值里有这个词也算：多删不要紧
    expect(ds.results.get('count:{"favorite":true,"q":"pose"}', () => 2)).toBe(2);
    const after = await readAll(ds);
    expect(after.summary).toBe(before.summary);
    expect(after.kinds).toBe(before.kinds);
    expect(after.duplicates).toBe(before.duplicates);
    expect(w.builds()).toBe(builds);
    expect(after).toEqual(before);
  });
});

describe('进角色页清掉「+N」', () => {
  it('只重算这个角色的 +N：角色和作品不重建，别的缓存不动，对外还是 catalog.characterChanged', async () => {
    const ds = await open();
    const before = await readAll(ds);
    const c1 = before.characters.items.find((c) => c.id === chr('c1'))!;
    expect(c1.newCount).toBeGreaterThan(0);
    const w = watchDerived(ds);
    const builds = w.builds();
    const refresh = vi.spyOn(ds.searchQueries, 'refreshNow');
    const unrecognized = vi.spyOn(ds.unrecognized, 'invalidate');
    env.events.length = 0;
    await ds.markCharacterSeen(chr('c1'));
    const got = await readAll(ds);
    expect(w.builds()).toBe(builds);
    expect(got.summary).toBe(before.summary);
    expect(got.kinds).toBe(before.kinds);
    expect(got.duplicates).toBe(before.duplicates);
    expect(refresh).not.toHaveBeenCalled();
    expect(unrecognized).not.toHaveBeenCalled();
    // 只有 c1 的 +N 变了
    expect(got.characters.items.find((c) => c.id === chr('c1'))).toEqual({ ...c1, newCount: 0 });
    expect(got.characters.items.filter((c) => c.id !== chr('c1'))).toEqual(before.characters.items.filter((c) => c.id !== chr('c1')));
    expect(got.works).toEqual(before.works);
    const changed = env.events.filter((e): e is Extract<ServerEvent, { type: 'changed' }> => e.type === 'changed');
    expect(changed.map((e) => [e.changes, e.command])).toEqual([[['catalog.characterChanged'], 'catalog.markSeen']]);
    // 和整份重建的结果一样
    ds.ctx.invalidate();
    expect(got).toEqual(await readAll(ds));
    // 已经没有 +N：不再写库、不发事件
    env.events.length = 0;
    await ds.markCharacterSeen(chr('c1'));
    expect(env.events.filter((e) => e.type === 'changed')).toEqual([]);
  });
});

describe('后台任务在跑的时候旧数多用一会儿', () => {
  it('角色 / 作品聚合：有任务在跑或排队时 30 秒，都结束了回到 10 秒；标签张数：跑着的时候 60 秒，结束了下次搜索就重数', async () => {
    // 软窗口只在文件库上有（内存库是 0）
    const dir = makeTmpDir('soft-window');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), {
      autoJobs: false,
      importDict: false,
      jobRunner: () => () => gate,
    });
    cleanup.push(async () => {
      release();
      await ds.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/soft');
      INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general');
      INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '爱丽丝', 'alice_(game_a)', 'danbooru', '2000-01-01');`);
    const add = (id: number) => {
      db.prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
         VALUES (?, 1, ?, 'a.png', 1200, 1700, 1, 'png', ?, '2026-01-01', '2026-01-01', 'x')`,
      ).run(id, `${id}.png`, `s${id}`);
      db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, 1, 0.9)').run(id);
      db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, 1, 'manual', 'user', 'x')").run(id);
    };
    add(1);
    ds.ctx.invalidate();
    let now = 5_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const count = async () => (await ds.getCharacter('1'))!.character.imageCount;
    const tagCount = async () => (await ds.search({ q: 'thighhighs' })).flatMap((h) => (h.type === 'tag' ? [h.imageCount] : []))[0];
    /** 后台任务又认出一张 */
    const background = (id: number) => {
      add(id);
      runAs('job:tag', () => ds.ctx.apply(() => ds.ctx.changed({ type: 'evidence.changed', ids: [id], provider: 'tagger' })));
    };
    expect([await count(), await tagCount()]).toEqual([1, 1]);

    // 没有任务在跑：聚合 10 秒，标签张数不等
    background(2);
    now += 9_000;
    expect([await count(), await tagCount()]).toEqual([1, 2]);
    now += 2_000;
    expect(await count()).toBe(2);

    // 任务跑着：聚合 30 秒，标签张数 60 秒
    await ds.startJob('dedupe');
    await vi.waitFor(async () => expect((await ds.listJobs())[0]).toMatchObject({ kind: 'dedupe', status: 'running' }));
    background(3);
    now += 29_000;
    expect([await count(), await tagCount()]).toEqual([2, 2]);
    now += 2_000;
    expect([await count(), await tagCount()]).toEqual([3, 2]);
    now += 30_000;
    expect(await tagCount()).toBe(3);

    // 用户的操作不等：马上对
    add(4);
    ds.ctx.invalidate();
    expect([await count(), await tagCount()]).toEqual([4, 4]);

    // 任务结束：攒着的软失效按 10 秒 / 0 秒算
    background(5);
    expect([await count(), await tagCount()]).toEqual([4, 4]);
    release();
    await vi.waitFor(async () => expect((await ds.listJobs())[0]).toMatchObject({ kind: 'dedupe', status: 'done' }));
    expect(await tagCount()).toBe(5);
    now += 11_000;
    expect(await count()).toBe(5);
  });
});
