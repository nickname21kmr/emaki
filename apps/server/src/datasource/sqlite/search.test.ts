import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { runAs } from '../../propagation/actor.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import type { Derived } from './derived.ts';
import { refreshTagCounts, SearchQueries } from './search.ts';

/** 原来的写法：从计入张数的图出发联 image_tags 分组。新写法要和它逐个一致 */
function expectedCounts(db: Db): Map<number, number> {
  const n = new Map<number, number>();
  for (const [id, c] of db
    .prepare('SELECT it.tag_id, COUNT(*) FROM image_tags it JOIN v_counted_images i ON i.id = it.image_id GROUP BY it.tag_id')
    .raw()
    .all() as [number, number][])
    n.set(id, c);
  return n;
}

function actualCounts(db: Db): Map<number, number> {
  return new Map((db.prepare('SELECT id, image_count FROM tags WHERE image_count <> 0').raw().all() as [number, number][]).map(([id, c]) => [id, c]));
}

describe('refreshTagCounts', () => {
  it('总数减去不计数的图：排除、回收站、丢失、文件夹停用 / 移除的都不算，只写变了的行', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0), (3, 'D:/c', 1);
      UPDATE library_roots SET removed_at = 'x' WHERE id = 3;
      INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');`);
    const tag = db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'general')");
    for (let t = 1; t <= 12; t++) tag.run(t, `t${t}`);
    const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
        excluded_by, missing, trashed_at) VALUES (?, ?, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', ?, ?, ?)`);
    const addTag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.9)');
    db.transaction(() => {
      for (let id = 1; id <= 300; id++) {
        const root = id % 9 === 0 ? 2 : id % 11 === 0 ? 3 : 1;
        img.run(id, root, `${id}.png`, `s${id}`, id % 5 === 0 ? 1 : null, id % 13 === 0 ? 1 : 0, id % 17 === 0 ? 'x' : null);
        for (let t = 1; t <= 12; t++) if ((id * t) % 7 < 3 || t === 12) addTag.run(id, t);
      }
    })();
    // t11 只出现在不计数的图上，应当是 0
    db.prepare('DELETE FROM image_tags WHERE tag_id = 11 AND image_id IN (SELECT id FROM v_counted_images)').run();
    db.prepare('UPDATE tags SET image_count = 99 WHERE id = 11').run();

    refreshTagCounts(db);
    const want = expectedCounts(db);
    expect(want.size).toBeGreaterThan(5);
    expect(actualCounts(db)).toEqual(want);
    expect(db.prepare('SELECT image_count FROM tags WHERE id = 11').pluck().get()).toBe(0);

    // 再改一张图：只有它的标签那几行被写
    db.exec(`CREATE TEMP TABLE writes (id INTEGER);
      CREATE TEMP TRIGGER tw AFTER UPDATE OF image_count ON tags BEGIN INSERT INTO writes VALUES (new.id); END;`);
    db.prepare("UPDATE images SET trashed_at = 'y' WHERE id = 1").run();
    const tagsOf1 = db.prepare('SELECT tag_id FROM image_tags WHERE image_id = 1 ORDER BY tag_id').pluck().all();
    refreshTagCounts(db);
    expect(actualCounts(db)).toEqual(expectedCounts(db));
    expect(db.prepare('SELECT id FROM writes ORDER BY id').pluck().all()).toEqual(tagsOf1);
  });
});

describe('搜索的标签张数', () => {
  it('图库有变化只标记过期，下次搜索时才刷新（后台不再定时重算）', async () => {
    const dataDir = makeTmpDir('search');
    const bus = new EventBus();
    const ds = await SqliteDataSource.open(bus, dataDir, { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general');`);
    for (let id = 1; id <= 3; id++) {
      db.prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x')`,
      ).run(id, `${id}.png`, `s${id}`);
      db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, 1, 0.9)').run(id);
    }
    const hit = async () => {
      const h = (await ds.search({ q: 'thighhighs' })).find((x) => x.type === 'tag');
      return h?.type === 'tag' ? h.imageCount : 0;
    };
    const stored = () => db.prepare("SELECT image_count FROM tags WHERE name = 'thighhighs'").pluck().get();
    expect(await hit()).toBe(3);

    db.prepare("UPDATE images SET trashed_at = 'x' WHERE id = 1").run();
    ds.ctx.invalidate('all', { soft: true }); // 后台任务写库后，变更传播的提交后反应就是这样让缓存失效的
    expect(stored()).toBe(3); // 只是标记了
    expect(await hit()).toBe(2); // 不用等计时器，下一次搜索就是新的
    expect(stored()).toBe(2);
    expect((await ds.tagSuggestions({ q: 'thigh' })).map((t) => t.count)).toEqual([2]);

    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('一句话拆标签 / ⌘K 中文标签', () => {
  it('只认库里有图的标签；张数、总数和「必含」同一口径（分数够才算）', async () => {
    const dataDir = makeTmpDir('phrase');
    const ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO tags (id, name, category) VALUES (1, '2girls', 'general'), (2, 'black_hair', 'general'), (3, 'long_hair', 'general'), (4, 'twintails', 'general');
      INSERT INTO tag_i18n (tag, category, zh, aliases) VALUES ('2girls', 0, '两个女孩', '[]'), ('black_hair', 0, '黑发', '["黑毛"]'),
        ('long_hair', 0, '长发', '[]'), ('twintails', 0, '双马尾', '[]'), ('blonde_hair', 0, '金发', '[]');`);
    // 1–3 张：2girls + black_hair + long_hair；第 3 张 black_hair 分数不够；第 4 张只有 long_hair；双马尾只在不达标的分数上
    const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
      VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', 'x')`);
    const tag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)');
    for (let id = 1; id <= 4; id++) img.run(id, `${id}.png`, `s${id}`);
    for (const id of [1, 2, 3]) tag.run(id, 1, 0.9), tag.run(id, 2, id === 3 ? 0.3 : 0.9), tag.run(id, 3, 0.9);
    tag.run(4, 3, 0.9);
    tag.run(4, 4, 0.2);

    const r = await ds.tagPhrase({ q: '两个黑色长发女孩' });
    expect(r.tags).toEqual([
      { tag: '2girls', name: '两个女孩', count: 3 },
      { tag: 'black_hair', name: '黑发', count: 2 },
      { tag: 'long_hair', name: '长发', count: 4 },
    ]);
    expect(r).toMatchObject({ rest: '', total: 2 });
    expect(r.total).toBe((await ds.listImages({ tagsAll: ['2girls', 'black_hair', 'long_hair'], limit: 1 })).total);
    // 金发库里没有图、双马尾分数都不够：都不认，留在 rest
    expect(await ds.tagPhrase({ q: '金发双马尾' })).toEqual({ tags: [], rest: '金发双马尾', total: 0 });

    // ⌘K：中文名、别名也能搜到标签，带中文显示名
    const hits = (await ds.search({ q: '黑毛' })).filter((h) => h.type === 'tag');
    expect(hits).toEqual([{ type: 'tag', tag: 'black_hair', name: '黑发', imageCount: 3 }]);

    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('标签张数只在会改到它的变化之后重数', () => {
  let env: ContractEnv | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await env?.close();
    env = undefined;
  });
  const img = (id: string) => env!.id('image', id);
  /** tags.image_count 和从计入张数的图重新全量数的一致 */
  const expectExact = (db: Db) => {
    const want = expectedCounts(db);
    expect(want.size).toBeGreaterThan(0);
    expect(actualCounts(db)).toEqual(want);
  };

  it('收藏、改分级、归类、移出、放下、标原创、进角色页之后搜索和联想：不重数', async () => {
    env = await sqliteFactory();
    const ds = env.ds as SqliteDataSource;
    const c5 = env.id('character', 'c5');
    await ds.tagSuggestions({ q: '' });
    const refresh = vi.spyOn(ds.searchQueries, 'refreshNow');
    const ops: (() => Promise<unknown>)[] = [
      () => ds.bulkImages({ ids: [img('i5')], action: { type: 'favorite', value: true } }),
      () => ds.bulkImages({ ids: [img('i6')], action: { type: 'rating', value: 'general' } }),
      () => ds.bulkImages({ ids: [img('i27')], action: { type: 'assign', characterId: c5 } }),
      () => ds.bulkImages({ ids: [img('i19')], action: { type: 'unassign', characterId: c5 } }),
      () => ds.bulkImages({ ids: [img('i26')], action: { type: 'shelve', value: true } }),
      () => ds.bulkImages({ ids: [img('i29')], action: { type: 'original', value: true } }),
      () => ds.markCharacterSeen(env!.id('character', 'c1')),
    ];
    for (const op of ops) {
      await op();
      expect((await ds.tagSuggestions({ q: '' })).length).toBeGreaterThan(0);
      await ds.search({ q: 'girl' });
    }
    expect(refresh).not.toHaveBeenCalled();
    expectExact(ds.ctx.db);
  });

  it('排除、移到回收站、撤销、后台任务认出一批之后：下一次联想就重数，张数和重新全量数的一致', async () => {
    env = await sqliteFactory();
    const ds = env.ds as SqliteDataSource;
    const db = ds.ctx.db;
    const count = async () => (await ds.tagSuggestions({ q: '1girl' }))[0]!.count;
    const refresh = vi.spyOn(ds.searchQueries, 'refreshNow');
    const start = await count();
    expect(refresh).toHaveBeenCalledTimes(1); // 进程里第一次
    const excluded = await ds.bulkImages({ ids: [img('i5')], action: { type: 'exclude' } });
    expect(await count()).toBe(start - 1);
    expectExact(db);
    const trashed = await ds.bulkImages({ ids: [img('i6'), img('i9')], action: { type: 'trash' } });
    expect(await count()).toBe(start - 3);
    expectExact(db);
    await ds.undo(trashed.undoToken!);
    await ds.undo(excluded.undoToken!);
    expect(await count()).toBe(start);
    expectExact(db);
    // 识别任务给一张图写了新标签（后台任务声明证据变了）
    db.prepare("INSERT INTO tags (id, name, category) VALUES (9001, 'new_tag', 'general')").run();
    db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, 9001, 0.9)').run(Number(img('i5')));
    runAs('job:tag', () => ds.ctx.apply(() => ds.ctx.changed({ type: 'evidence.changed', ids: [Number(img('i5'))], provider: 'tagger' })));
    expect((await ds.tagSuggestions({ q: 'new_tag' })).map((t) => t.count)).toEqual([1]);
    expectExact(db);
  });

  it('后台任务连着写库：时间窗里只重数一次，过了窗口才再数；用户的操作不等', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'D:/x'); INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general');");
    const add = (id: number) => {
      db.prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x')`,
      ).run(id, `${id}.png`, `s${id}`);
      db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, 1, 0.9)').run(id);
    };
    let now = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let windowMs = 60_000;
    const derived = { get: () => ({ characters: new Map(), works: new Map(), builtAt: 0 }) } as unknown as Derived;
    const q = new SearchQueries(db, derived, { countsSoftMs: () => windowMs });
    const refresh = vi.spyOn(q, 'refreshNow');
    const count = () => q.tagSuggestions({ q: 'thigh' })[0]?.count ?? 0;
    add(1);
    expect(count()).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // 后台任务每几秒写一批
    for (const id of [2, 3, 4]) {
      now += 5_000;
      add(id);
      q.dropKeys();
      q.markCountsStale(true);
      expect(count()).toBe(1);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    now += 46_000;
    expect(count()).toBe(4);
    expect(refresh).toHaveBeenCalledTimes(2);
    // 用户的操作（硬失效）：马上重数
    add(5);
    q.dropKeys();
    q.markCountsStale();
    expect(count()).toBe(5);
    // 任务都结束了（窗口变成 0）：攒着的软失效下一次搜索就重数
    add(6);
    q.dropKeys();
    q.markCountsStale(true);
    expect(count()).toBe(5);
    windowMs = 0;
    expect(count()).toBe(6);
    db.close();
  });
});

describe('归类弹窗的搜索（forAssignment）', () => {
  let env: ContractEnv | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await env?.close();
    env = undefined;
  });

  it('还没建档的候选整份缓存：结果和每次现算的一样；按标签建档、排除之后候选跟着变', async () => {
    env = await sqliteFactory();
    const ds = env.ds as SqliteDataSource;
    const db = ds.ctx.db;
    const img = (id: string) => env!.id('image', id);
    // 再加两条对不上角色的建议：一条在未识别的图上，一条在已经排除的图上（不计入）
    db.prepare(
      "INSERT INTO character_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', 'test_boy_(emaki_test)', 0.4), (?, 'tagger', 'hidden_girl_(emaki_test)', 0.4)",
    ).run(Number(img('i28')), Number(img('i32')));
    ds.ctx.invalidate();
    const queries = ['test', 'girl', 'emaki', 'mika', 'test girl', 'boy', 'hidden', 'ブルー', 'zzz'];
    /** 不带缓存、每次现算的结果 */
    const uncached = (q: string) => new SearchQueries(db, ds.derived).search({ q, forAssignment: true }, ds.makeCatalog().catalog);
    const expectSame = async () => {
      for (const q of queries) expect(await ds.search({ q, forAssignment: true }), q).toEqual(uncached(q));
    };
    const candidates = async (q: string) =>
      (await ds.search({ q, forAssignment: true })).flatMap((h) => (h.type === 'characterCandidate' ? [h.danbooruTag] : []));
    expect(await candidates('test')).toEqual(['test_boy_(emaki_test)', 'test_girl_(emaki_test)']);
    expect(await candidates('hidden')).toEqual([]);
    await expectSame();

    // 敲字的过程中候选不再现算
    const prepare = vi.spyOn(db, 'prepare');
    const computed = () => prepare.mock.calls.filter(([sql]) => String(sql).includes('FROM v_character_suggestions s JOIN v_counted_images')).length;
    for (const q of ['t', 'te', 'tes', 'test']) await ds.search({ q, forAssignment: true });
    expect(computed()).toBe(0);
    // 收藏、改分级、放下不影响候选
    await ds.bulkImages({ ids: [img('i5')], action: { type: 'favorite', value: true } });
    await ds.bulkImages({ ids: [img('i28')], action: { type: 'rating', value: 'sensitive' } });
    await ds.bulkImages({ ids: [img('i28')], action: { type: 'shelve', value: true } });
    expect(await candidates('test')).toEqual(['test_boy_(emaki_test)', 'test_girl_(emaki_test)']);
    expect(computed()).toBe(0);
    prepare.mockRestore();

    // 按标签建档：这个标签有角色了，不再是候选，而是角色
    const made = await ds.acceptSuggestion(img('i27'), 'test_girl_(emaki_test)');
    expect(await candidates('test')).toEqual(['test_boy_(emaki_test)']);
    expect(
      (await ds.search({ q: 'test', forAssignment: true })).some((h) => h.type === 'character' && h.character.danbooruTag === 'test_girl_(emaki_test)'),
    ).toBe(true);
    await expectSame();
    await ds.undo(made.undoToken!);
    expect(await candidates('test')).toEqual(['test_boy_(emaki_test)', 'test_girl_(emaki_test)']);
    await expectSame();
    // 排除带着这条建议的图：不计入，候选没了；恢复后回来
    const excluded = await ds.bulkImages({ ids: [img('i28')], action: { type: 'exclude' } });
    expect(await candidates('test')).toEqual(['test_girl_(emaki_test)']);
    await expectSame();
    await ds.undo(excluded.undoToken!);
    expect(await candidates('test')).toEqual(['test_boy_(emaki_test)', 'test_girl_(emaki_test)']);
    await expectSame();
  });
});
