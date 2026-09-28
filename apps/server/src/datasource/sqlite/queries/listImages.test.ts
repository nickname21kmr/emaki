import type { ImageSort, ListImagesQuery, Rating } from '@emaki/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { listImages } from './listImages.ts';

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
  const ic = db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'tagger', '2026-01-01')");
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

/** 按 mock 的规则在 JS 里过滤 */
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

describe('listImages 筛选与 mock 规则一致', () => {
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
