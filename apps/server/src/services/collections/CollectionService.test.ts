import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { CollectionService } from './CollectionService.ts';

let db: Db;
let svc: CollectionService;
const NOW = Date.parse('2026-09-27T12:00:00.000Z');

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/Pics', 1)").run();
  svc = new CollectionService(db, () => NOW);
});
afterEach(() => db.close());

let nextId = 1;
function add(dir: string, files: string[], o: { w?: number; h?: number; kind?: string; mtime?: (i: number) => string } = {}): number[] {
  const ins = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
      content_kind, content_kind_source, tagged_at)
    VALUES (@id, 1, @rel, @file, @w, @h, 1000, 'jpeg', @sha, '2026-01-01T00:00:00.000Z', @mtime, @kind, 'tags', '2026-01-01T00:00:00.000Z')`);
  return files.map((file, i) => {
    const id = nextId++;
    ins.run({
      id,
      rel: `${dir}/${file}`,
      file,
      w: o.w ?? 1200,
      h: o.h ?? 1700,
      sha: `s${id}`,
      mtime: o.mtime?.(i) ?? '2026-01-01T00:00:00.000Z',
      kind: o.kind ?? 'comic',
    });
    return id;
  });
}
const pages = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(3, '0')}.jpg`);
const pageNos = (ids: number[]) =>
  ids.map((id) => db.prepare('SELECT collection_id AS c, page_no AS p FROM images WHERE id = ?').get(id) as { c: number | null; p: number | null });

describe('refreshAll', () => {
  it('① 新建一本自动合集，页码 1..20；② 再跑一次什么都不变', () => {
    const ids = add('Book', pages(20));
    const r = svc.refreshAll();
    expect(r).toMatchObject({ active: 1, created: 1, removed: 0, updated: 0, pagesChanged: 20 });
    expect(pageNos(ids).map((x) => x.p)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(db.prepare('SELECT kind, origin, rel_dir FROM collections').get()).toEqual({ kind: 'doujin', origin: 'auto', rel_dir: 'Book' });
    expect(svc.refreshAll()).toMatchObject({ created: 0, removed: 0, updated: 0, pagesChanged: 0 });
  });

  it('③ 排除一页后它离开合集，其余页重新编号 1..19', () => {
    const ids = add('Book', pages(20));
    svc.refreshAll();
    db.prepare("INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'image', ?, 'x', '2026-01-01T00:00:00.000Z')").run(
      String(ids[4]),
    );
    db.prepare('UPDATE images SET excluded_by = 1 WHERE id = ?').run(ids[4]);
    svc.refreshAll();
    const after = pageNos(ids);
    expect(after[4]).toEqual({ c: null, p: null });
    expect(after.filter((_, i) => i !== 4).map((x) => x.p)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  });

  it('④ 不成册：所有页离开合集，行保留', () => {
    const ids = add('Book', pages(20));
    svc.refreshAll();
    db.prepare("UPDATE collections SET state = 'dismissed'").run();
    svc.refreshAll();
    expect(pageNos(ids).every((x) => x.c === null)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) FROM collections').pluck().get()).toBe(1);
  });

  it('⑤ 手动合集的文件夹改名后跟着搬', () => {
    const ids = add('Book', pages(20));
    svc.refreshAll();
    db.prepare("UPDATE collections SET origin = 'manual'").run();
    db.prepare("UPDATE images SET rel_path = 'Renamed/' || file_name").run();
    svc.refreshAll();
    expect(db.prepare('SELECT rel_dir FROM collections').pluck().all()).toEqual(['Renamed']);
    expect(pageNos(ids).every((x) => x.c !== null)).toBe(true);
  });

  it('⑥ 照片页超过 20% 后自动合集被删除', () => {
    const ids = add('Book', pages(20));
    svc.refreshAll();
    db.prepare("UPDATE images SET content_kind = 'photo' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids.slice(0, 5)));
    expect(svc.refreshAll()).toMatchObject({ removed: 1, active: 0 });
    expect(pageNos(ids).every((x) => x.c === null)).toBe(true);
  });

  it('⑦ uuid 名的页按修改时间排', () => {
    const names = ['c3f0e7a2-0000-4000-8000-000000000001', '0a1b2c3d-0000-4000-8000-000000000002', 'ffee0011-0000-4000-8000-000000000003'];
    const files = Array.from({ length: 12 }, (_, i) => `${names[i % 3]!.slice(0, 32)}${String(i).padStart(4, '0')}.jpg`);
    // 修改时间倒着给：第 12 个文件最早
    const ids = add('5c4fe8c847fa5e791d2d9189', files, { w: 1280, h: 1818, kind: 'illustration', mtime: (i) => `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}.000Z` });
    svc.refreshAll();
    expect(db.prepare('SELECT page_order FROM collections').pluck().get()).toBe('mtime');
    expect(pageNos(ids).map((x) => x.p)).toEqual(Array.from({ length: 12 }, (_, i) => 12 - i));
  });

  it('⑧ 自动合集的页全部进回收站后，这一行被删除（RV-C-14）', () => {
    add('Book', pages(20));
    svc.refreshAll();
    db.prepare("UPDATE images SET trashed_at = '2026-09-27T00:00:00.000Z'").run();
    expect(svc.refreshAll()).toMatchObject({ removed: 1, active: 0 });
  });
});

describe('refreshDirs / assignPages', () => {
  it('只重算涉及的目录', () => {
    const a = add('BookA', pages(10));
    const b = add('BookB', pages(10));
    svc.refreshAll();
    db.prepare("UPDATE images SET content_kind = 'screenshot' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(a.slice(0, 5)));
    const r = svc.refreshDirs([a[0]!]);
    expect(r).toMatchObject({ removed: 1, active: 1 });
    expect(pageNos(a).every((x) => x.c === null)).toBe(true);
    expect(pageNos(b).every((x) => x.c !== null)).toBe(true);
  });

  it('改页序后重排', () => {
    const ids = add('Book', pages(10), { mtime: (i) => `2026-01-01T00:00:${String(59 - i).padStart(2, '0')}.000Z` });
    svc.refreshAll();
    const id = db.prepare('SELECT id FROM collections').pluck().get() as number;
    db.prepare("UPDATE collections SET page_order = 'mtime'").run();
    expect(svc.assignPages(id)).toEqual([...ids].reverse());
  });
});
