import { rmSync } from 'node:fs';
import path from 'node:path';
import { UNRECOGNIZED_THEMES, type ListUnrecognizedQuery, type ListUnrecognizedResponse } from '@emaki/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { UnrecognizedQueries, useSqlQueueForTests } from './unrecognized.ts';

let env: ContractEnv;
beforeEach(async () => {
  env = await sqliteFactory();
});
afterEach(() => env.close());

it('边翻页边采纳每页第一张：遍历到的图集合 = 初始未识别集合（键集分页不漏图）', async () => {
  const initial = new Set<string>();
  let c: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ limit: 2, cursor: c });
    p.items.forEach((x) => initial.add(x.image.id));
    c = p.nextCursor ?? undefined;
  } while (c);

  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.ds.listUnrecognized({ limit: 2, cursor });
    page.items.forEach((x) => seen.add(x.image.id));
    const first = page.items[0];
    if (first) await env.ds.acceptSuggestion(first.image.id, 'hina_(blue_archive)');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(initial);
});

/** 「没认出」按像插画的程度排：分数相同按 id 倒序；键集分页不重不漏（T34a） */
it('没认出：按 art_score 倒序、同分 id 倒序，翻页不重不漏', async () => {
  const db = (env.ds as unknown as { ctx: { db: import('better-sqlite3').Database } }).ctx.db;
  db.exec('DELETE FROM character_evidence');
  const six = ['i24', 'i25', 'i26', 'i27', 'i28', 'i29'].map((x) => Number(env.id('image', x)));
  const scores = [10, 10, 5, 5, 5, 0];
  six.forEach((id, k) => db.prepare("UPDATE images SET theme = 'legs', rating = 'general', art_score = ? WHERE id = ?").run(scores[k], id));
  (env.ds as unknown as { ctx: { invalidate: (s: string) => void } }).ctx.invalidate('all');
  const got: { id: number; s: number }[] = [];
  let cursor: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ bucket: 'unsure', theme: 'legs', limit: 2, cursor });
    expect(p.total).toBe(6);
    for (const x of p.items) got.push({ id: Number(x.image.id), s: scores[six.indexOf(Number(x.image.id))]! });
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(got.map((g) => g.id))).toEqual(new Set(six));
  expect(got).toHaveLength(6);
  for (let k = 1; k < got.length; k++) {
    expect(got[k]!.s).toBeLessThanOrEqual(got[k - 1]!.s);
    if (got[k]!.s === got[k - 1]!.s) expect(got[k]!.id).toBeLessThan(got[k - 1]!.id);
  }
});

it('放下的：最近放下的在前，翻页不重不漏（T34a）', async () => {
  const ids = ['i24', 'i25', 'i26', 'i27', 'i28'].map((x) => env.id('image', x));
  for (const id of ids) await env.ds.bulkImages({ ids: [id], action: { type: 'shelve', value: true } });
  const got: string[] = [];
  let cursor: string | undefined;
  do {
    const p = await env.ds.listUnrecognized({ bucket: 'shelved', limit: 2, cursor });
    expect(p.total).toBe(5);
    got.push(...p.items.map((x) => x.image.id));
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(got)).toEqual(new Set(ids));
  expect(got).toHaveLength(5);
});

/** 可复现的伪随机 */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/**
 * 列表从读进内存的队列里切（pageFromQueue）；改之前每页现查整个队列的 SQL 写法留着（useSqlQueueForTests），这里逐页对比。
 * 库里故意放了：排序键大量并列、被排除 / 回收站 / 丢失 / 停用文件夹里的图、已经认出和归为原创的图、本子里的页，
 * 以及各种组图——跨分段的（有的成员有建议、有的没认出、有的待识别）、有成员放下了的、有成员已经认出的（整组几张 ≠ 队列里几张）、
 * 只剩一张的、插画和漫画混着的、解散了的、别册里的、成员多到跨页的。
 */
describe('读进内存的队列和 SQL 的写法逐页一样', () => {
  const ANNEX = ['screenshot', 'text', 'photo', 'meme'] as const;
  const THEMES = ['legs', 'chest', 'swim', 'kemono', 'costume', 'multi', 'other', 'odd', null];
  const RATINGS = ['general', 'sensitive', 'questionable', 'explicit'];
  const N = 460;
  let dir: string;
  let ds: SqliteDataSource;

  interface Img {
    kind: string;
    tagged: string | null;
    shelved: string | null;
    score: number | null;
    theme: string | null;
    rating: string;
    added: string;
    favorite: number;
    root: number;
    excluded: boolean;
    trashed: boolean;
    missing: boolean;
    linked: boolean;
    original: boolean;
    evidence: [string, number][];
  }

  beforeAll(async () => {
    dir = makeTmpDir('unrecognized-queue');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0);
      INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');
      INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '甲', 'kou', 'danbooru', 'x'), (2, '乙', 'otsu', 'danbooru', 'x');`);
    const r = rng(11);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const images = new Map<number, Img>();
    for (let id = 1; id <= N; id++) {
      const kind = id % 9 === 0 ? ANNEX[(id / 9) % 4]! : id % 11 === 0 ? 'comic' : 'illustration';
      const tagged = r() < 0.75 ? `2026-02-${String(1 + Math.floor(r() * 9)).padStart(2, '0')}T00:00:00.000Z` : null;
      const status = r();
      images.set(id, {
        kind,
        tagged,
        shelved: r() < 0.07 ? `2026-03-0${1 + Math.floor(r() * 4)}T00:00:00.000Z` : null,
        score: tagged ? pick([90, 70, 70, 50, 50, 50, 20, null]) : null,
        theme: tagged ? pick(THEMES) : null,
        rating: pick(RATINGS),
        added: `2026-01-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}T00:00:00.000Z`,
        favorite: r() < 0.3 ? 1 : 0,
        root: status < 0.03 ? 2 : 1,
        excluded: status >= 0.03 && status < 0.06,
        trashed: status >= 0.06 && status < 0.08,
        missing: status >= 0.08 && status < 0.1,
        linked: r() < 0.08,
        original: r() < 0.03,
        evidence: r() < 0.14 ? [[pick(['kou', 'otsu', 'someone_else']), pick([0.4, 0.55, 0.55, 0.8])]] : [],
      });
    }
    // 组图的成员：把要考的情况写死（没写到的属性照上面随机出来的）
    const plain = { root: 1, excluded: false, trashed: false, missing: false, linked: false, original: false, shelved: null, evidence: [] };
    const unsure = { ...plain, kind: 'illustration', tagged: '2026-02-01T00:00:00.000Z' };
    const set = (id: number, patch: Partial<Img>) => Object.assign(images.get(id)!, patch);
    // 一：三张都没认出、都收藏了
    for (const [id, score] of [
      [20, 90],
      [21, 50],
      [23, 50],
    ] as const) {
      set(id, { ...unsure, score, favorite: 1, theme: 'legs', rating: 'general' });
    }
    // 二：跨分段——有建议、没认出两张、待识别
    set(30, { ...unsure, evidence: [['kou', 0.8], ['otsu', 0.4]] });
    set(31, { ...unsure, score: 70, favorite: 1, theme: 'chest', rating: 'general' });
    set(32, { ...unsure, score: 70, favorite: 0, theme: 'swim', rating: 'explicit' });
    set(34, { ...plain, kind: 'illustration', tagged: null, score: null, theme: null });
    // 三：一张放下了
    set(40, { ...unsure, shelved: '2026-03-02T00:00:00.000Z' });
    set(41, { ...unsure });
    // 四：一张已经认出来了（不在队列里，但算在整组的张数里）
    set(50, { ...unsure, linked: true });
    set(51, { ...unsure });
    set(52, { ...unsure });
    // 五：另一张进了回收站，整组只剩一张（当单张）
    set(60, { ...unsure });
    set(61, { ...unsure, trashed: true });
    // 六：插画和漫画混着
    set(70, { ...unsure });
    set(71, { ...unsure, kind: 'comic' });
    set(73, { ...unsure, kind: 'comic', tagged: null });
    // 七：解散了的组（不收拢）
    set(80, { ...unsure });
    set(82, { ...unsure });
    // 八：别册里的组
    set(108, { ...plain });
    set(117, { ...plain });
    set(126, { ...plain });
    // 九：成员多到跨页，排序键和别的图并列
    for (const id of [130, 131, 133, 134, 136, 137, 138]) set(id, { ...unsure, score: 50, added: '2026-01-05T00:00:00.000Z' });
    // 十：两张都放下了
    set(150, { ...unsure, shelved: '2026-03-03T00:00:00.000Z' });
    set(151, { ...unsure, shelved: '2026-03-03T00:00:00.000Z' });
    // 本子里的页：整本处理，不进队列
    for (const id of [160, 161, 163]) set(id, { ...unsure });

    const insert = db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, rating, favorite,
         tagged_at, shelved_at, art_score, theme, excluded_by, trashed_at, missing, original_at)
       VALUES (@id, @root, @file, @file, 100, 140, 1, 'png', @sha, @added, 'x', @kind, @rating, @favorite,
         @tagged, @shelved, @score, @theme, @ex, @trashed, @missing, @original)`,
    );
    const link = db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, 1, 'manual', 'user', 'x')");
    const evidence = db.prepare("INSERT INTO character_evidence (image_id, provider, tag, score) VALUES (?, 'tagger', ?, ?)");
    db.transaction(() => {
      for (const [id, x] of images) {
        insert.run({
          id,
          root: x.root,
          file: `${id}.png`,
          sha: `s${id}`,
          added: x.added,
          kind: x.kind,
          rating: x.rating,
          favorite: x.favorite,
          tagged: x.tagged,
          shelved: x.shelved,
          score: x.score,
          theme: x.theme,
          ex: x.excluded ? 1 : null,
          trashed: x.trashed ? 'x' : null,
          missing: x.missing ? 1 : 0,
          original: x.original ? '2026-02-01' : null,
        });
        if (x.linked) link.run(id);
        for (const [tag, score] of x.evidence) evidence.run(id, tag, score);
      }
      const collection = db.prepare(
        `INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, title, origin, state, created_at, updated_at, membership)
         VALUES (?, 1, ?, ?, 'manual', ?, 'manual', ?, 'x', 'x', ?)`,
      );
      const member = db.prepare('UPDATE images SET collection_id = ?, page_no = ? WHERE id = ?');
      const group = (id: number, members: number[], o: { kind?: string; state?: string; title?: string | null } = {}) => {
        const kind = o.kind ?? 'group';
        const title = o.title === undefined ? `组${id}` : o.title;
        collection.run(id, kind === 'group' ? `@selection/${id}` : `books/${id}`, kind, title, o.state ?? 'active', kind === 'group' ? 'selection' : 'folder');
        members.forEach((image, k) => member.run(id, k + 1, image));
      };
      group(1, [20, 21, 23]);
      group(2, [30, 31, 32, 34], { title: null });
      group(3, [40, 41]);
      group(4, [50, 51, 52]);
      group(5, [60, 61]);
      group(6, [70, 71, 73]);
      group(7, [80, 82], { state: 'dismissed' });
      group(8, [108, 117, 126]);
      group(9, [130, 131, 133, 134, 136, 137, 138]);
      group(10, [150, 151]);
      group(11, [160, 161, 163], { kind: 'doujin' });
    })();
    ds.ctx.invalidate();
  }, 60_000);

  afterAll(async () => {
    useSqlQueueForTests(false);
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 从头翻到尾（同一种写法） */
  async function walk(q: ListUnrecognizedQuery, limit: number, sql: boolean): Promise<ListUnrecognizedResponse[]> {
    useSqlQueueForTests(sql);
    try {
      const pages: ListUnrecognizedResponse[] = [];
      let cursor: string | undefined;
      do {
        const page = await ds.listUnrecognized({ ...q, limit, cursor });
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && pages.length < 600);
      return pages;
    } finally {
      useSqlQueueForTests(false);
    }
  }

  /** 两种写法各翻一遍，逐页逐字段相同；返回内存写法的结果 */
  async function same(q: ListUnrecognizedQuery, limit: number) {
    const want = await walk(q, limit, true);
    const got = await walk(q, limit, false);
    expect(got, JSON.stringify({ q, limit })).toEqual(want);
    return got;
  }

  const art: ListUnrecognizedQuery[] = [];
  for (const artKind of [undefined, 'illustration', 'comic'] as const) {
    for (const bucket of [undefined, 'suggested', 'unsure', 'untagged', 'shelved'] as const) art.push({ bucket, artKind });
    for (const theme of UNRECOGNIZED_THEMES) art.push({ bucket: 'unsure', theme, artKind });
  }
  const annex: ListUnrecognizedQuery[] = [undefined, ...ANNEX].map((kind) => ({ area: 'annex', kind }));
  const groupsOn = (pages: ListUnrecognizedResponse[]) =>
    pages.flatMap((p) => p.items.flatMap((i) => (i.image.collectionGroup ? [i.image.collectionGroup] : [])));
  const idsOn = (pages: ListUnrecognizedResponse[]) => pages.flatMap((p) => p.items.map((i) => i.image.id));

  it('库里各种情况都有', async () => {
    const all = await same({ collapseCollections: true }, 200);
    expect(all[0]!.total).toBeGreaterThan(300);
    const groups = new Map(groupsOn(all).map((g) => [g.id, g]));
    // 一、二、三、四、六、九在不分段的列表里各占一格；五只剩一张、七解散了、十都放下了、十一是本子，都不是一格
    expect([...groups.keys()].sort((a, b) => Number(a) - Number(b))).toEqual(['1', '2', '3', '4', '6', '9']);
    expect(groups.get('1')).toMatchObject({ count: 3, total: 3, allFavorite: true, memberIds: ['20', '21', '23'], title: '组1', kind: 'group' });
    expect(groups.get('2')).toMatchObject({ count: 4, total: 4, allFavorite: false, title: null });
    expect(groups.get('3')).toMatchObject({ count: 1, total: 2, memberIds: ['41'] });
    expect(groups.get('4')).toMatchObject({ count: 2, total: 3, memberIds: ['51', '52'] });
    expect(groups.get('9')).toMatchObject({ count: 7, total: 7 });
    expect(all[0]!.displayTotal).toBe(all[0]!.total - (3 + 4 + 1 + 2 + 3 + 7) + 6);
    expect(idsOn(all)).toEqual(expect.arrayContaining(['60', '80', '82']));
    expect(idsOn(all)).not.toEqual(expect.arrayContaining(['160']));
    // 跨分段的组：有建议、没认出、待识别里各有一格，成员各算各的
    const of = async (q: ListUnrecognizedQuery) => groupsOn(await same({ ...q, collapseCollections: true }, 200)).find((g) => g.id === '2');
    expect((await of({ bucket: 'suggested' }))?.memberIds).toEqual(['30']);
    expect((await of({ bucket: 'unsure' }))?.memberIds).toEqual(['31', '32']);
    expect((await of({ bucket: 'untagged' }))?.memberIds).toEqual(['34']);
    expect((await of({ bucket: 'unsure', theme: 'nsfw' }))?.memberIds).toEqual(['32']);
    expect(groupsOn(await same({ bucket: 'shelved', collapseCollections: true }, 200)).map((g) => [g.id, g.memberIds])).toEqual(
      expect.arrayContaining([
        ['3', ['40']],
        ['10', ['150', '151']],
      ]),
    );
    expect(groupsOn(await same({ artKind: 'comic', collapseCollections: true }, 200)).find((g) => g.id === '6')?.memberIds).toEqual(['71', '73']);
    expect(groupsOn(await same({ area: 'annex', collapseCollections: true }, 200)).map((g) => g.id)).toEqual(['8']);
    // 每个分段、每个主题、每类别册都有图
    for (const q of [...art.filter((x) => !x.artKind), ...annex]) expect((await same(q, 200))[0]!.items.length, JSON.stringify(q)).toBeGreaterThan(0);
  });

  it('每个大类、分段、主题、类型：收拢和不收拢、一页 120 张', async () => {
    for (const q of [...art, ...annex]) for (const collapseCollections of [true, false]) await same({ ...q, collapseCollections }, 120);
  });

  it('每个大类、分段、主题、类型：收拢、一页 7 张', async () => {
    for (const q of [...art, ...annex]) await same({ ...q, collapseCollections: true }, 7);
  });

  it('一页 4 张、1 张（游标落在组里、落在并列的排序键中间）', async () => {
    const some: ListUnrecognizedQuery[] = [
      {},
      { bucket: 'suggested' },
      { bucket: 'unsure' },
      { bucket: 'untagged' },
      { bucket: 'shelved' },
      { bucket: 'unsure', artKind: 'comic' },
      { bucket: 'unsure', theme: 'legs' },
      { area: 'annex' },
    ];
    for (const q of some) for (const collapseCollections of [true, false]) await same({ ...q, collapseCollections }, 4);
    const small: ListUnrecognizedQuery[] = [{ bucket: 'suggested' }, { bucket: 'shelved' }, { bucket: 'unsure', theme: 'nsfw' }, { area: 'annex', kind: 'text' }];
    for (const q of small) {
      const pages = await same({ ...q, collapseCollections: true }, 1);
      expect(pages.length).toBe(pages[0]!.displayTotal);
    }
  });

  it("collapseCollections='auto'：超过门槛才收拢，翻页沿用第一页的决定", async () => {
    const big = await same({ collapseCollections: 'auto' }, 50);
    expect(big.every((p) => p.collapsed === true)).toBe(true);
    expect(groupsOn(big).length).toBe(6);
    const small = await same({ bucket: 'suggested', collapseCollections: 'auto' }, 7);
    expect(small[0]!.total).toBeLessThan(300);
    expect(small.every((p) => p.collapsed === undefined && p.displayTotal === undefined)).toBe(true);
    await same({ area: 'annex', collapseCollections: 'auto' }, 7);
    await same({ bucket: 'unsure', collapseCollections: 'auto' }, 120);
  });

  it('无效的游标、别的排序模式的游标 → 400', async () => {
    const first = await ds.listUnrecognized({ limit: 2 });
    await expect(ds.listUnrecognized({ cursor: 'not-a-cursor' })).rejects.toThrow('分页游标无效');
    await expect(ds.listUnrecognized({ bucket: 'unsure', cursor: first.nextCursor! })).rejects.toThrow('分页游标无效');
  });

  it('收藏、分级直接改在库里（不清缓存）：列表里的收藏、整组是不是都收藏了、按主题筛的结果照样是新的', async () => {
    const db = ds.ctx.db;
    await same({ collapseCollections: true }, 120); // 队列已经读进内存
    const before = db.prepare('SELECT id, favorite, rating FROM images').all() as { id: number; favorite: number; rating: string }[];
    try {
      db.exec(`UPDATE images SET favorite = 0 WHERE id = 21;
        UPDATE images SET favorite = 1 WHERE id IN (30, 32, 34, 51);
        UPDATE images SET rating = 'explicit' WHERE id IN (20, 21);
        UPDATE images SET rating = 'general' WHERE id = 32;`);
      const all = await same({ collapseCollections: true }, 120);
      const groups = new Map(groupsOn(all).map((g) => [g.id, g]));
      expect(groups.get('1')!.allFavorite).toBe(false);
      expect(groups.get('2')!.allFavorite).toBe(true);
      const cell = all.flatMap((p) => p.items).find((i) => i.image.collectionGroup?.id === '1')!;
      expect(cell.image).toMatchObject({ id: '20', favorite: true, rating: 'explicit' });
      // 20、21 现在是敏感的，32 不是了
      const legs = await same({ bucket: 'unsure', theme: 'legs', collapseCollections: true }, 120);
      expect(groupsOn(legs).find((g) => g.id === '1')?.memberIds).toEqual(['23']);
      const nsfw = await same({ bucket: 'unsure', theme: 'nsfw', collapseCollections: true }, 120);
      expect(groupsOn(nsfw).find((g) => g.id === '1')?.memberIds).toEqual(['20', '21']);
      expect(groupsOn(nsfw).find((g) => g.id === '2')).toBeUndefined();
      for (const theme of UNRECOGNIZED_THEMES) await same({ bucket: 'unsure', theme, collapseCollections: false }, 120);
    } finally {
      const restore = db.prepare('UPDATE images SET favorite = @favorite, rating = @rating WHERE id = @id');
      db.transaction(() => before.forEach((row) => restore.run(row)))();
    }
  });

  it('一边翻一边归类、放下、收藏、改分级：每一页两种写法都一样，不重复、不漏图', async () => {
    const db = ds.ctx.db;
    const snapshot = db.prepare('SELECT id, favorite, rating, shelved_at FROM images').all() as {
      id: number;
      favorite: number;
      rating: string;
      shelved_at: string | null;
    }[];
    const initial = new Set(idsOn(await walk({ collapseCollections: true }, 200, false)));
    const seen: string[] = [];
    const handled = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        useSqlQueueForTests(true);
        const want = await ds.listUnrecognized({ collapseCollections: true, limit: 9, cursor });
        useSqlQueueForTests(false);
        const page = await ds.listUnrecognized({ collapseCollections: true, limit: 9, cursor });
        expect(page, `第 ${pages + 1} 页`).toEqual(want);
        seen.push(...page.items.map((i) => i.image.id));
        // 这一页处理掉几张：第一张归给角色，第二张放下，第三张收藏，第四张改分级
        const [a, b, c, d] = page.items.map((i) => i.image.id);
        if (a) await ds.bulkImages({ ids: [a], action: { type: 'assign', characterId: '2' } });
        if (b) await ds.bulkImages({ ids: [b], action: { type: 'shelve', value: true } });
        if (c) await ds.bulkImages({ ids: [c], action: { type: 'favorite', value: true } });
        if (d) await ds.bulkImages({ ids: [d], action: { type: 'rating', value: 'explicit' } });
        for (const id of [a, b]) if (id) handled.add(id);
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 200);
      expect(pages).toBeGreaterThan(20);
      expect(new Set(seen).size).toBe(seen.length);
      // 开始时在列表里的每一格都翻到过（没因为前面处理掉几张就跳过去）；归类、放下的不再在队列里
      for (const id of initial) expect(seen.includes(id), id).toBe(true);
      const rest = new Set(idsOn(await walk({ collapseCollections: false }, 200, false)));
      for (const id of handled) expect(rest.has(id), id).toBe(false);
      // 处理完之后从头再翻一遍，两种写法还是一样
      await same({ collapseCollections: true }, 50);
      await same({ bucket: 'shelved', collapseCollections: true }, 50);
    } finally {
      useSqlQueueForTests(false);
      // 还原：别的用例还要用这个库
      db.transaction(() => {
        db.prepare('DELETE FROM image_characters WHERE character_id = 2').run();
        const restore = db.prepare('UPDATE images SET favorite = @favorite, rating = @rating, shelved_at = @shelved_at WHERE id = @id');
        snapshot.forEach((row) => restore.run(row));
      })();
      ds.ctx.invalidate();
    }
  });

  it('队列读一次放着：库里直接改了也不变，失效后（软的也算）就是新的', async () => {
    const db = ds.ctx.db;
    const queries = new UnrecognizedQueries(ds.ctx, () => ds.makeCatalog().catalog, 40);
    const first = queries.list({ limit: 5 }).items.map((i) => i.image.id);
    const top = Number(first[0]);
    const now = () => queries.list({ limit: 5 }).items.map((i) => i.image.id);
    db.prepare("UPDATE images SET shelved_at = '2026-04-01' WHERE id = ?").run(top);
    try {
      expect(now()).toEqual(first);
      queries.invalidate(true);
      expect(now()).not.toContain(String(top));
      // 库里改回去：没失效之前还是刚才那份；硬失效之后马上是新的
      db.prepare('UPDATE images SET shelved_at = NULL WHERE id = ?').run(top);
      expect(now()).not.toContain(String(top));
      queries.invalidate();
      expect(now()).toEqual(first);
    } finally {
      db.prepare('UPDATE images SET shelved_at = NULL WHERE id = ?').run(top);
    }
  });
});
