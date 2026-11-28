import type { ImageSort, ListImagesQuery, Rating } from '@emaki/shared';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../core/events.ts';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { SqliteDataSource } from '../../../../test/helpers/client.ts';
import { makeTmpDir } from '../../../../test/helpers/tmp.ts';
import { listImages, type TextMatch, type TextMatchCache } from './listImages.ts';

/** 可复现的伪随机 */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ref {
  id: number;
  root: number;
  width: number;
  height: number;
  bytes: number;
  rating: Rating;
  favorite: boolean;
  added: string;
  modified: string;
  file: string;
  chars: number[];
  copyrights: number[];
  excluded: boolean;
  missing: boolean;
  trashed: boolean;
}

const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];
let db: Db;
let refs: Ref[] = [];
let nextId = 1;
const r = rng(42);
// 角色 → 作品：c1,c2 → w1；c3 → w2
const CHAR_WORK: Record<number, number> = { 1: 1, 2: 1, 3: 2 };

function insert(n: number) {
  const ins = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, rating, favorite,
      added_at, modified_at, excluded_by, missing, trashed_at)
    VALUES (@id, @root, @file, @file, @width, @height, @bytes, 'png', @sha, @rating, @fav, @added, @modified, @ex, @missing, @trashed)`);
  const ic = db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, rule, added_at) VALUES (?, ?, 'auto', 'job:tag', 'auto-accept@1', '2026-01-01')");
  const icr = db.prepare('INSERT INTO image_copyrights (image_id, work_id) VALUES (?, ?)');
  const tag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.9)');
  db.transaction(() => {
    for (let k = 0; k < n; k++) {
      const id = nextId++;
      const shape = r();
      const width = 1000;
      const height = shape < 0.5 ? 1500 : shape < 0.8 ? 600 : 1000;
      const chars = r() < 0.2 ? [] : [1 + Math.floor(r() * 3)];
      if (chars.length && r() < 0.1) chars.push(chars[0] === 3 ? 1 : 3);
      const ref: Ref = {
        id,
        root: r() < 0.8 ? 1 : r() < 0.5 ? 2 : 3, // 2 = 停用，3 = 已移除
        width,
        height,
        bytes: 1000 + Math.floor(r() * 50) * 100, // 故意制造很多相同值，考验游标的平手处理
        rating: RATINGS[Math.floor(r() * 4)]!,
        favorite: r() < 0.2,
        added: new Date(Date.UTC(2026, 0, 1 + Math.floor(r() * 60))).toISOString(),
        modified: new Date(Date.UTC(2025, 0, 1 + Math.floor(r() * 300))).toISOString(),
        file: `${['Apple', 'banana', 'cherry', 'Date'][Math.floor(r() * 4)]}_${id}.png`,
        chars,
        copyrights: !chars.length && r() < 0.3 ? [2] : [],
        excluded: r() < 0.1,
        missing: r() < 0.05,
        trashed: r() < 0.05,
      };
      refs.push(ref);
      ins.run({
        id,
        root: ref.root,
        file: ref.file,
        width,
        height,
        bytes: ref.bytes,
        sha: `s${id}`,
        rating: ref.rating,
        fav: ref.favorite ? 1 : 0,
        added: ref.added,
        modified: ref.modified,
        ex: ref.excluded ? 1 : null,
        missing: ref.missing ? 1 : 0,
        trashed: ref.trashed ? '2026-02-01' : null,
      });
      for (const c of chars) ic.run(id, c);
      for (const w of ref.copyrights) icr.run(id, w);
      if (id % 7 === 0) tag.run(id, 1);
    }
  })();
}

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0), (3, 'D:/c', 1);
    UPDATE library_roots SET removed_at = '2026-01-01' WHERE id = 3;
    INSERT INTO works (id, name, created_at) VALUES (1, 'W1', 'x'), (2, 'W2', 'x');
    INSERT INTO characters (id, name, source, created_at) VALUES (1, 'A', 'custom', 'x'), (2, 'B', 'custom', 'x'), (3, 'C', 'custom', 'x');
    INSERT INTO character_works (character_id, work_id) VALUES (1, 1), (2, 1), (3, 2);
    INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');
    INSERT INTO tags (id, name, category) VALUES (1, 'blue_hair', 'general');`);
  refs = [];
  insert(500);
});

/** 用 JS 写一遍的参照规则（来自以前 mock 的实现）：和 SQL 的结果对照 */
function expected(q: ListImagesQuery): Ref[] {
  return refs.filter((x) => {
    if (x.missing || x.trashed || x.root !== 1) return false;
    const status = x.excluded ? 'excluded' : x.chars.length ? 'recognized' : 'unrecognized';
    if (q.status ? status !== q.status : status === 'excluded') return false;
    if (q.characterId && !x.chars.includes(Number(q.characterId))) return false;
    if (q.workId) {
      const works = new Set([...x.chars.map((c) => CHAR_WORK[c]!), ...x.copyrights]);
      if (!works.has(Number(q.workId))) return false;
    }
    if (q.rating?.length && !q.rating.includes(x.rating)) return false;
    if (q.favorite !== undefined && x.favorite !== q.favorite) return false;
    if (q.orientation) {
      const ratio = x.width / x.height;
      const o = ratio > 1.05 ? 'landscape' : ratio < 0.95 ? 'portrait' : 'square';
      if (o !== q.orientation) return false;
    }
    if (q.q === 'blue' && x.id % 7 !== 0) return false;
    if (q.q === 'banana' && !x.file.toLowerCase().includes('banana')) return false;
    return true;
  });
}

function pageAll(q: ListImagesQuery): number[] {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = listImages(db, { ...q, limit: 37, cursor });
    ids.push(...page.items.map((i) => Number(i.id)));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('分页没有结束');
}

describe('listImages 筛选与参照规则一致', () => {
  it.each<[string, ListImagesQuery]>([
    ['默认', {}],
    ['excluded', { status: 'excluded' }],
    ['recognized', { status: 'recognized' }],
    ['unrecognized', { status: 'unrecognized' }],
    ['角色', { characterId: '1' }],
    ['作品（含只有 copyright 的图）', { workId: '2' }],
    ['分级', { rating: ['questionable', 'explicit'] }],
    ['收藏', { favorite: true }],
    ['竖图', { orientation: 'portrait' }],
    ['横图', { orientation: 'landscape' }],
    ['方图', { orientation: 'square' }],
    ['标签搜索', { q: 'blue' }],
    ['文件名搜索（大小写不敏感）', { q: 'BANANA' }],
    ['非法角色 id', { characterId: 'c1' }],
  ])('%s', (_name, q) => {
    const want = q.characterId === 'c1' ? [] : expected(q.q === 'BANANA' ? { ...q, q: 'banana' } : q).map((x) => x.id).sort((a, b) => a - b);
    const got = pageAll(q).sort((a, b) => a - b);
    expect(got).toEqual(want);
    expect(listImages(db, q).total).toBe(want.length);
  });
});

describe('排序 × 顺序：翻完所有页不重不漏，顺序正确', () => {
  const sorts: ImageSort[] = ['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random'];
  for (const sort of sorts)
    for (const order of ['asc', 'desc'] as const) {
      it(`${sort} ${order}`, () => {
        const ids = pageAll({ sort, order });
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBe(expected({}).length);
        if (sort === 'random') return;
        const byId = new Map(refs.map((x) => [x.id, x]));
        const key = (id: number) => {
          const x = byId.get(id)!;
          return sort === 'addedAt' ? x.added : sort === 'modifiedAt' ? x.modified : sort === 'fileName' ? x.file.toLowerCase() : x.bytes;
        };
        for (let i = 1; i < ids.length; i++) {
          const a = key(ids[i - 1]!);
          const b = key(ids[i]!);
          if (order === 'asc') expect(a <= b).toBe(true);
          else expect(a >= b).toBe(true);
        }
      });
    }
});

describe('随机排序（不收拢）：先只排 id、再按 id 取整行', () => {
  it.each([[undefined], [7], [1073741823]])('seed=%s：和带着整行排序的写法逐页一样，偏移游标接得上，每一项的内容不变', (seed) => {
    // 原来的写法：一条查询带着整行排序，LIMIT / OFFSET 取一页（这里只取 id，顺序由同一个 ORDER BY 决定）
    const old = (where: string) =>
      db
        .prepare(`SELECT i.id FROM v_counted_images i WHERE ${where} ORDER BY (((i.id + @seed) * 2654435761) % 4294967296), i.id LIMIT @lim OFFSET @off`)
        .pluck();
    // 每一项的内容：和按入库时间翻页（整行直接取出来的那条路）拿到的同一张图逐字段相同
    const byId = new Map<string, unknown>();
    let c: string | undefined;
    do {
      const page = listImages(db, { limit: 200, cursor: c });
      for (const item of page.items) byId.set(item.id, item);
      c = page.nextCursor ?? undefined;
    } while (c);

    let checked = 0;
    for (const [q, where] of [
      [{}, '1'],
      [{ favorite: true }, 'i.favorite = 1'],
      [{ order: 'desc' }, '1'], // 随机不分正倒序
    ] as [ListImagesQuery, string][]) {
      const reference = old(where);
      for (const limit of [1, 37, 200]) {
        let cursor: string | undefined;
        let offset = 0;
        for (let pages = 0; pages < (limit === 1 ? 25 : 100); pages++) {
          const page = listImages(db, { ...q, sort: 'random', seed, limit, cursor });
          const want = reference.all({ seed: seed ?? 0, lim: limit, off: offset }) as number[];
          expect(page.items.map((i) => Number(i.id)), JSON.stringify({ q, limit, offset })).toEqual(want);
          for (const item of page.items) expect(item).toEqual(byId.get(item.id));
          checked += page.items.length;
          offset += limit;
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (limit > 1) expect(cursor, '翻到底了').toBeUndefined();
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

it('翻页途中插入新图不会产生重复', () => {
  const first = listImages(db, { limit: 50 });
  insert(10);
  const seen = new Set(first.items.map((i) => i.id));
  let cursor = first.nextCursor;
  while (cursor) {
    const page = listImages(db, { limit: 50, cursor });
    for (const item of page.items) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    cursor = page.nextCursor;
  }
});

it('无效游标 → 400', () => {
  expect(() => listImages(db, { cursor: 'not-a-cursor' })).toThrow('分页游标无效');
});

it('按标签筛（画面、自定义画面）只看识别过的图：文件内容变了、等重新识别的图留着旧标签也不算', () => {
  const d = openDatabase(':memory:');
  migrate(d);
  d.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1);
    INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general'), (2, 'comic', 'general');
    INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
      VALUES (1, 1, '1.png', '1.png', 100, 150, 1, 'png', 's1', 'x', 'x', 'x'),
             (2, 1, '2.png', '2.png', 100, 150, 1, 'png', 's2', 'x', 'x', NULL);
    INSERT INTO image_tags (image_id, tag_id, score) VALUES (1, 1, 0.9), (2, 1, 0.9);`);
  const ids = (q: ListImagesQuery) => listImages(d, q).items.map((i) => i.id);
  expect(ids({ tags: ['thighhighs'] })).toEqual(['1']);
  expect(ids({ tagsAll: ['thighhighs'] })).toEqual(['1']);
  expect(ids({ tagsAll: ['thighhighs'], tagsNone: ['comic'] })).toEqual(['1']);
  expect(ids({ tagsNone: ['comic'] })).toEqual(['1']);
  expect(listImages(d, { tagsAll: ['thighhighs'] }).total).toBe(1);
  expect(ids({ theme: 'legs' })).toEqual(['1']);
});

describe('按角色翻页', () => {
  it.each<[string, ListImagesQuery]>([
    ['角色 + 收藏', { characterId: '1', favorite: true }],
    ['角色 + 排除', { characterId: '3', status: 'excluded' }],
    ['角色 + 作品', { characterId: '1', workId: '1' }],
    ['角色 + 标签搜索', { characterId: '2', q: 'blue' }],
    ['角色 + 文件名升序', { characterId: '3', sort: 'fileName', order: 'asc' }],
  ])('%s：翻完所有页和参照规则一致', (_name, q) => {
    const want = expected(q).map((x) => x.id);
    const got = pageAll(q);
    expect([...got].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
    expect(listImages(db, q).total).toBe(want.length);
  });

  it('翻页查询先按角色取图（idx_ic_character_image），不沿排序索引逐张探测全库', () => {
    // 计划看统计信息：造一个两万张、这个角色只有 20 张的库再 ANALYZE，比例接近真实库
    const d = openDatabase(':memory:');
    migrate(d);
    d.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1);
      INSERT INTO characters (id, name, source, created_at) VALUES (1, 'A', 'custom', 'x'), (2, 'B', 'custom', 'x');`);
    const img = d.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
      VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, ?, 'x')`);
    const ic = d.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, rule, added_at) VALUES (?, ?, 'auto', 'job:tag', 'auto-accept@1', 'x')");
    d.transaction(() => {
      for (let id = 1; id <= 20_000; id++) {
        img.run(id, `${id}.png`, `s${id}`, new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString());
        if (id % 1000 === 0) ic.run(id, 1);
        else if (id % 3 === 0) ic.run(id, 2);
      }
    })();
    d.exec('ANALYZE');
    const sqls: string[] = [];
    const prepare = d.prepare.bind(d);
    const spy = vi.spyOn(d, 'prepare').mockImplementation(((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof d.prepare);
    const page = listImages(d, { characterId: '1', limit: 5 });
    spy.mockRestore();
    expect(page.items.map((i) => i.id)).toEqual(['20000', '19000', '18000', '17000', '16000']);
    const sql = sqls.find((s) => s.includes('LIMIT @lim'))!;
    const plan = (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ cid: 1, lim: 6 }) as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan).toContain('idx_ic_character_image');
    expect(plan).not.toMatch(/SCAN i\b/);
  });
});

describe('是否动图（D5）', () => {
  it('animated=true 只看动图、false 只看静态，和类型组合；按入库时间翻页走只含动图的部分索引', () => {
    // 两万张、动图 1%：比例接近真实库，计划看统计信息
    const d = openDatabase(':memory:');
    migrate(d);
    d.exec("INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1)");
    const img = d.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
        content_kind, frame_count, animated)
      VALUES (?, 1, ?, 'a.gif', 1, 1, 1, 'gif', ?, ?, 'x', ?, ?, ?)`);
    d.transaction(() => {
      for (let id = 1; id <= 20_000; id++) {
        const moving = id % 100 === 0;
        img.run(id, `${id}.gif`, `s${id}`, new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(), id % 200 === 0 ? 'meme' : 'illustration', moving ? 12 : 1, moving ? 1 : 0);
      }
    })();
    d.exec('ANALYZE');
    expect(listImages(d, { animated: true, limit: 3 }).items.map((i) => [i.id, i.kind, i.animated])).toEqual([
      ['20000', 'meme', true],
      ['19900', 'illustration', true],
      ['19800', 'meme', true],
    ]);
    expect(listImages(d, { animated: true }).total).toBe(200);
    expect(listImages(d, { animated: true, kind: ['illustration'] }).total).toBe(100);
    expect(listImages(d, { animated: false }).total).toBe(19_800);
    expect(listImages(d, { kind: ['meme'] }).total).toBe(100);

    const sqls: string[] = [];
    const prepare = d.prepare.bind(d);
    const spy = vi.spyOn(d, 'prepare').mockImplementation(((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof d.prepare);
    listImages(d, { animated: true, limit: 5 });
    spy.mockRestore();
    const sql = sqls.find((s) => s.includes('LIMIT @lim'))!;
    const plan = (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ lim: 6 }) as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan).toContain('idx_images_animated_live');
  });
});

describe('文字搜索：数总数的写法、候选的缓存', () => {
  let d: Db;
  beforeAll(() => {
    d = openDatabase(':memory:');
    migrate(d);
    d.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1);
      INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');
      INSERT INTO works (id, name, danbooru_tag, created_at) VALUES
        (1, 'Blue Archive', 'blue_archive', 'x'), (2, '原创', 'original', 'x'), (3, 'Arknights', 'arknights', 'x');
      INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES
        (1, '未花', 'misono_mika', 'danbooru', 'x'), (2, 'Amiya', NULL, 'custom', 'x');
      INSERT INTO character_works (character_id, work_id) VALUES (1, 1), (2, 3);
      INSERT INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('work', 3, '明日方舟', '明日方舟', 'user', 1, 0);
      INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general'), (2, 'long_hair', 'general');
      INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES ('长发', 'long_hair', 'zh', 'dict');`);
    const img = d.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, excluded_by, original_at)
      VALUES (@id, 1, @file, @file, 100, 150, 1, 'png', @sha, @at, 'x', @ex, @original)`);
    const add = (id: number, file: string, extra: { excluded?: boolean; original?: boolean } = {}) =>
      img.run({ id, file, sha: `s${id}`, at: `2026-01-${String(id).padStart(2, '0')}`, ex: extra.excluded ? 1 : null, original: extra.original ? '2026-02-01' : null });
    add(1, 'Mika_01.png'); // 只有文件名里有 mika
    add(2, 'a.png'); // 只有标签 thighhighs
    add(3, 'b.png'); // 只有角色未花（标签 misono_mika；她的作品 Blue Archive 也算）
    add(4, 'c.png'); // 只有手动指定的作品 Blue Archive
    add(5, 'd.png', { original: true }); // 原创图
    add(6, 'e.png'); // 什么都没有
    add(7, 'Thighhighs_long.png'); // 文件名、两个标签都中
    add(8, 'mika_thighhighs.png', { excluded: true }); // 被排除：都不算
    add(9, 'f.png'); // 角色 Amiya（作品 Arknights，别名 明日方舟）
    add(10, 'g.png'); // 标签 long_hair（中文名 长发）
    d.exec(`INSERT INTO image_tags (image_id, tag_id, score) VALUES (2, 1, 0.9), (7, 1, 0.9), (7, 2, 0.9), (8, 1, 0.9), (10, 2, 0.9);
      INSERT INTO image_copyrights (image_id, work_id) VALUES (4, 1);`);
    const ic = d.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', 'x')");
    ic.run(3, 1);
    ic.run(9, 2);
  });

  const all = (q: ListImagesQuery, fn = listImages) => {
    const ids: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = fn(d, { ...q, limit: 2, cursor });
      ids.push(...page.items.map((i) => Number(i.id)));
      if (!page.nextCursor) return ids.sort((a, b) => a - b);
      cursor = page.nextCursor;
    }
    throw new Error('分页没有结束');
  };

  // 翻页的条件还是原来的写法（逐行 EXISTS、文件名在最前），数总数是 CASE WHEN：两边筛出来的必须是同一批图
  it.each<[string, string, number[]]>([
    ['只有文件名命中', 'mika_0', [1]],
    ['文件名和角色标签各中一张', 'MIKA', [1, 3]],
    ['只有标签命中', 'thighhigh', [2, 7]],
    ['标签的中文名', '长发', [7, 10]],
    ['只有作品命中（手动指定的作品、作品下的角色）', 'blue archive', [3, 4]],
    ['作品的别名', '明日方舟', [9]],
    ['「原创」', '原创', [5]],
    ['文件名和标签都中的只算一次', 'long', [7, 10]],
    ['什么都不中', 'zzzz', []],
  ])('%s', (_name, q, want) => {
    expect(all({ q })).toEqual(want);
    expect(listImages(d, { q }).total).toBe(want.length);
    // 和别的条件一起、收拢时（组图那条查询用的也是数总数的写法）
    expect(listImages(d, { q, collapseCollections: true }).total).toBe(want.length);
    expect(listImages(d, { q, orientation: 'portrait' }).total).toBe(want.length);
    expect(listImages(d, { q, favorite: true }).total).toBe(0);
  });

  it('同一个词第二次搜不再去标签、角色、作品表里找候选；换一个词才再找', () => {
    const memo = new Map<string, TextMatch>();
    const keys: string[] = [];
    const texts: TextMatchCache = (key, compute) => {
      keys.push(key);
      let hit = memo.get(key);
      if (!hit) memo.set(key, (hit = compute()));
      return hit;
    };
    const sqls: string[] = [];
    const prepare = d.prepare.bind(d);
    const spy = vi.spyOn(d, 'prepare').mockImplementation(((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof d.prepare);
    const candidates = () => sqls.filter((s) => s.includes('tag_name_keys') || s.includes('FROM aliases')).length;
    try {
      const first = listImages(d, { q: 'Mika' }, undefined, texts);
      expect(candidates()).toBe(3); // 标签、作品、角色各一条
      const again = listImages(d, { q: 'ＭＩＫＡ', limit: 1 }, undefined, texts);
      expect(candidates()).toBe(3);
      expect(again.total).toBe(first.total);
      expect(keys).toEqual(['mika', 'mika']);
      expect(memo.get('mika')).toEqual({ tagIds: [], characterIds: [1], workIds: [] });
      listImages(d, { q: 'blue' }, undefined, texts);
      expect(candidates()).toBe(6);
      // 不带缓存的调用照旧每次现找
      listImages(d, { q: 'Mika' });
      expect(candidates()).toBe(9);
    } finally {
      spy.mockRestore();
    }
    expect(all({ q: 'mika' }, (db, q) => listImages(db, q, undefined, texts))).toEqual([1, 3]);
  });
});

describe('文字搜索候选的缓存跟着库里的变化失效（经引擎，结果缓存的 qtext: 键）', () => {
  it('改角色名、加别名、识别出新标签之后再搜，结果是新的；收藏、改分级、放下不影响', async () => {
    const dir = makeTmpDir('qtext');
    const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    try {
      const db = ds.ctx.db;
      db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/a');
        INSERT INTO characters (id, name, source, created_at) VALUES (1, 'Alpha', 'custom', 'x');
        INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
          VALUES (1, 1, '1.png', '1.png', 100, 150, 1, 'png', 's1', 'x', 'x', 'x'), (2, 1, '2.png', '2.png', 100, 150, 1, 'png', 's2', 'x', 'x', 'x');
        INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (1, 1, 'manual', 'user', 'x');`);
      ds.ctx.invalidate();
      const hits = async (q: string) => {
        const page = await ds.listImages({ q });
        expect(page.total).toBe(page.items.length);
        return page.items.map((i) => i.id);
      };
      // 先把这几个词都搜一遍：没命中的结果也进了缓存
      expect(await hits('alpha')).toEqual(['1']);
      expect(await hits('beta')).toEqual([]);
      expect(await hits('gamma')).toEqual([]);
      expect(await hits('newtag')).toEqual([]);

      // 和候选无关的操作：缓存留着也好、清掉也好，结果都一样
      await ds.updateImage('1', { favorite: true });
      await ds.updateImage('1', { rating: 'explicit' });
      await ds.bulkImages({ ids: ['2'], action: { type: 'shelve', value: true } });
      expect(await hits('alpha')).toEqual(['1']);
      expect(await hits('beta')).toEqual([]);

      await ds.updateCharacter('1', { name: 'Beta' });
      expect(await hits('beta')).toEqual(['1']);
      await ds.updateCharacter('1', { aliases: ['Gamma'] });
      expect(await hits('gamma')).toEqual(['1']);
      // 识别任务写进新标签（后台任务经 apply 声明变化）
      ds.ctx.apply(() => {
        db.exec(`INSERT INTO tags (id, name, category) VALUES (901, 'newtag_x', 'general');
          INSERT INTO image_tags (image_id, tag_id, score) VALUES (2, 901, 0.9);`);
        ds.ctx.changed({ type: 'evidence.changed', ids: [2], provider: 'tagger' });
      });
      expect(await hits('newtag')).toEqual(['2']);
    } finally {
      await ds.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
