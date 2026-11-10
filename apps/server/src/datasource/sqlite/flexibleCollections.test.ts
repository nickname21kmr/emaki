import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';
import type { ListImagesQuery } from '@emaki/shared';

let ds: SqliteDataSource, dir: string;
beforeEach(async () => {
  dir = makeTmpDir('flexible-collections');
  ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  for (const n of [1, 2]) {
    const root = path.join(dir, 'root' + n);
    await mkdir(root);
    ds.ctx.db.prepare('INSERT INTO library_roots (id,path) VALUES (?,?)').run(n, root);
  }
});
afterEach(async () => {
  await ds.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function image(id: number, options: { root?: number; parent?: string; post?: string; site?: string; favorite?: boolean } = {}) {
  const root = options.root ?? 1,
    name = `image_${id}.png`,
    rel = options.parent ? options.parent + '/' + name : name;
  await mkdir(path.join(dir, 'root' + root, options.parent ?? ''), { recursive: true });
  await writeFile(path.join(dir, 'root' + root, rel), 'original-' + id);
  ds.ctx.db
    .prepare(
      `INSERT INTO images (id,root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,
    source_site,source_post_id,favorite,tagged_at) VALUES (?,?,?,?,1000,1400,100,'png',?,?,?, ?,?,?,?)`,
    )
    .run(
      id,
      root,
      rel,
      name,
      'sha-' + id,
      `2026-01-${String(id).padStart(2, '0')}`,
      '2026-01-01',
      options.post ? (options.site ?? 'pixiv') : null,
      options.post ?? null,
      options.favorite ? 1 : 0,
      '2026-01-01',
    );
  return String(id);
}
const create = (imageIds: string[], title = '同质图片') => ds.createCollection({ imageIds, title, kind: 'group' });
const members = async (id: string) => (await ds.getCollection(id))!.pages.map((p) => p.imageId);
const walk = async (q: ListImagesQuery) => {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await ds.listImages({ ...q, limit: 1, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
};

describe('ordinary collections', () => {
  it('selects across directories/roots without moving files or changing image metadata; survives repeated scans', async () => {
    await image(1, { parent: 'a' });
    await image(2, { root: 2, parent: 'b' });
    const r = await create(['1', '2']);
    expect(r.collection.pageCount).toBe(2);
    for (let i = 0; i < 3; i++) ds.collections.refreshAll();
    expect(await members(r.collection.id)).toEqual(['1', '2']);
    expect((await ds.getImage('1'))!.relPath).toBe('a/image_1.png');
    expect((await ds.getImage('2'))!.libraryRootId).toBe('2');
    expect(await readFile(path.join(dir, 'root1/a/image_1.png'), 'utf8')).toBe('original-1');
    await ds.ctx.undo.run(r.undoToken!);
    expect((await ds.getImage('1'))!.collection).toBeNull();
    expect((await ds.getImage('2'))!.collection).toBeNull();
  });

  it('adds, removes, splits and dissolves without rejoining after refresh; every membership edit is undoable', async () => {
    for (let i = 1; i <= 4; i++) await image(i, { post: '12345678' });
    ds.collections.refreshAll();
    const source = (await ds.listCollections({}))[0]!;
    const split = await create(['1', '2'], '拆出的合集');
    expect(await members(source.id)).toEqual(['3', '4']);
    const add = await ds.updateCollection(split.collection.id, { addImageIds: ['3'] });
    ds.collections.refreshAll();
    expect(await members(split.collection.id)).toEqual(['1', '2', '3']);
    await ds.ctx.undo.run(add.undoToken!);
    expect(await members(source.id)).toEqual(['3', '4']);
    const remove = await ds.updateCollection(split.collection.id, { removeImageIds: ['1'] });
    ds.collections.refreshAll();
    expect((await ds.getImage('1'))!.collection).toBeNull();
    await ds.ctx.undo.run(remove.undoToken!);
    expect(await members(split.collection.id)).toEqual(['1', '2']);
    const dismiss = await ds.deleteCollection(split.collection.id);
    ds.collections.refreshAll();
    expect((await ds.getImage('1'))!.collection).toBeNull();
    await ds.ctx.undo.run(dismiss.undoToken!);
    expect(await members(split.collection.id)).toEqual(['1', '2']);
  });

  it('same post uses site + post ID, spans roots, adopts new members and responds to corrected sources', async () => {
    await image(1, { post: '123' });
    await image(2, { post: '123', root: 2 });
    await image(3, { post: '123', site: 'twitter' });
    const first = ds.collections.refreshAll();
    expect(first.created).toBe(1);
    const c = (await ds.listCollections({}))[0]!;
    expect(await members(c.id)).toEqual(['1', '2']);
    expect((await ds.getImage('3'))!.collection).toBeNull();
    expect(ds.collections.refreshAll().pagesChanged).toBe(0);
    await image(4, { post: '123' });
    ds.collections.refreshDirs([4]);
    expect(await members(c.id)).toEqual(['1', '2', '4']);
    ds.ctx.db.prepare("UPDATE images SET source_post_id = '456' WHERE id = 4").run();
    ds.collections.refreshAll();
    expect((await ds.getImage('4'))!.collection).toBeNull();
  });

  it('ordinary collections remain in the per-image recognition queue', async () => {
    await image(1);
    await image(2);
    await create(['1', '2']);
    const queue = await ds.listUnrecognized({ area: 'art', bucket: 'unsure' });
    expect(queue.items.map((i) => i.image.id).sort()).toEqual(['1', '2']);
  });

  it('source editing immediately groups matching posts and undo restores both the source and membership', async () => {
    await image(1, { post: '12345678' });
    await image(2);
    ds.collections.refreshAll();
    const r = await ds.updateImage('2', { source: { url: 'https://www.pixiv.net/artworks/12345678' } });
    const c = (await ds.listCollections({}))[0]!;
    expect(await members(c.id)).toEqual(['1', '2']);
    await ds.undo(r.undoToken!);
    expect((await ds.getImage('1'))!.collection).toBeNull();
    expect((await ds.getImage('2'))!.source).toBeNull();
    expect((await ds.getImage('2'))!.collection).toBeNull();
  });

  it('removing the last member keeps the collection editable; purge transfers cross-root ownership', async () => {
    await image(1);
    await image(2, { root: 2 });
    const r = await create(['1', '2']);
    ds.ctx.db.prepare("UPDATE library_roots SET removed_at = '2000-01-01' WHERE id = 1").run();
    ds.purgeRemovedRoots();
    expect(await members(r.collection.id)).toEqual(['2']);
    await ds.updateCollection(r.collection.id, { removeImageIds: ['2'] });
    expect((await ds.getCollection(r.collection.id))!.pages).toHaveLength(0);
    await ds.updateCollection(r.collection.id, { addImageIds: ['2'] });
    expect(await members(r.collection.id)).toEqual(['2']);
  });

  it('explicit comic folders still form books even if their images share a post', async () => {
    await image(1, { post: '12345678' });
    await image(2, { post: '12345678' });
    ds.ctx.db.prepare("UPDATE library_roots SET content_mode = 'comic' WHERE id = 1").run();
    ds.collections.refreshAll();
    const books = await ds.listCollections({});
    expect(books).toHaveLength(1);
    expect(books[0]!.kind).toBe('doujin');
  });

  it('adding a single file reuses the organized child and standard moves preserve ordinary collection membership', async () => {
    await image(1, { parent: 'a' });
    await image(2, { parent: 'a' });
    const r = await ds.createCollection({ imageIds: ['1', '2'], title: '测试', kind: 'group', organizeFiles: true });
    const organizedDir = path.posix.dirname((await ds.getImage('1'))!.relPath);
    await image(3, { parent: 'a' });
    await ds.updateCollection(r.collection.id, { addImageIds: ['3'], organizeFiles: true });
    expect(path.posix.dirname((await ds.getImage('3'))!.relPath)).toBe(organizedDir);
    await ds.moveImages({ ids: ['3'], rootId: '2', dir: 'chosen' });
    expect((await ds.getImage('3'))!.libraryRootId).toBe('2');
    expect((await ds.getImage('3'))!.collection!.id).toBe(r.collection.id);
  });

  it('unrecognized sheets collapse after filtering and paginate by groups while keeping the original image totals', async () => {
    for (let i = 1; i <= 5; i++) await image(i);
    const a = await create(['1', '3', '5']);
    await create(['2', '4']);
    const q = { area: 'art', bucket: 'unsure', collapseCollections: true, limit: 1 } as const;
    const first = await ds.listUnrecognized(q);
    expect(first).toMatchObject({ total: 5, displayTotal: 2 });
    expect(first.items[0]!.image.collectionGroup!.count).toBeGreaterThan(1);
    const second = await ds.listUnrecognized({ ...q, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    expect(new Set([first.items[0]!.image.collectionGroup!.id, second.items[0]!.image.collectionGroup!.id]).size).toBe(2);
    expect(
      [first, second].flatMap((p) => p.items).find((i) => i.image.collectionGroup?.id === a.collection.id)!.image.collectionGroup!
        .memberIds,
    ).toEqual(['1', '3', '5']);
  });

  it('folder organization is opt-in, keeps each parent separate and reverses file moves with the membership edit', async () => {
    for (let i = 1; i <= 4; i++) await image(i, { parent: i <= 2 ? 'a' : 'b' });
    const r = await ds.createCollection({ imageIds: ['1', '2', '3', '4'], title: '测试', kind: 'group', organizeFiles: true });
    for (const id of ['1', '2', '3', '4']) {
      const img = (await ds.getImage(id))!;
      expect(img.relPath).toContain(`[合集 ${r.collection.id}]/image_${id}.png`);
      expect(await readFile(img.absPath, 'utf8')).toBe('original-' + id);
    }
    expect((await readdir(path.join(dir, 'root1/a'))).length).toBe(1);
    expect((await ds.listChanges('move')).length).toBe(1);
    await ds.ctx.undo.run(r.undoToken!);
    for (const id of ['1', '2', '3', '4']) {
      expect((await ds.getImage(id))!.relPath).toBe(`${Number(id) <= 2 ? 'a' : 'b'}/image_${id}.png`);
      expect((await ds.getImage(id))!.collection).toBeNull();
    }
  });
});

describe('collapsed browsing', () => {
  it('groups before pagination, counts images separately, and preserves a filtered-out cover boundary', async () => {
    await image(1, { favorite: true });
    await image(2);
    await image(3, { favorite: true });
    await image(4);
    const a = await create(['1', '2']),
      b = await create(['3']);
    await ds.updateCollection(a.collection.id, { coverImageId: '2' });
    const result = await ds.listImages({ collapseCollections: true, favorite: true });
    expect(result).toMatchObject({ total: 2, displayTotal: 2 });
    const first = result.items.find((i) => i.collectionGroup?.id === a.collection.id)!;
    expect(first.id).toBe('1');
    expect(first.collectionGroup).toMatchObject({ count: 1, total: 2, memberIds: ['1'] });
    const all = await walk({ collapseCollections: true });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((i) => i.collectionGroup?.id ?? i.id)).size).toBe(3);
    expect((await ds.listImages({ collapseCollections: false })).items).toHaveLength(4);
    expect((await ds.listImages({ collapseCollections: true, collectionId: a.collection.id })).items).toHaveLength(2);
    expect(b.collection.pageCount).toBe(1);
  });

  it('offers visual candidates for explicit selection without altering membership or duplicate results', async () => {
    for (let i = 1; i <= 4; i++) await image(i);
    const hash = '55aa55aa55aa55aa';
    ds.ctx.db.prepare('UPDATE images SET dhash = ? WHERE id IN (1,2)').run(hash);
    ds.ctx.db.prepare("UPDATE images SET dhash = '0000000000000000' WHERE id = 3").run();
    ds.ctx.db.prepare("UPDATE images SET dhash = 'aa55aa55aa55aa55' WHERE id = 4").run();
    const list = await ds.listImages({ similarTo: '1' });
    expect(list.items.map(i => i.id)).toEqual(['2']);
    expect((await ds.getImage('2'))!.collection).toBeNull();
    expect((await ds.listDuplicates({ resolved: false }))).toEqual([]);
  });

  it('uses only the character-matching members and cover, for all sort modes and directions', async () => {
    for (let i = 1; i <= 6; i++) await image(i);
    const a = await create(['1', '4', '6']);
    await create(['2', '5']);
    const cid = String(
      ds.ctx.db.prepare("INSERT INTO characters(name,source,created_at) VALUES ('甲','custom','now')").run().lastInsertRowid,
    );
    await ds.bulkImages({ ids: ['1', '3', '4'], action: { type: 'assign', characterId: cid } });
    await ds.updateCollection(a.collection.id, { coverImageId: '6' });
    for (const sort of ['addedAt', 'fileName', 'bytes', 'modifiedAt', 'random'] as const)
      for (const order of ['asc', 'desc'] as const) {
        const all = await walk({ collapseCollections: true, characterId: cid, sort, order });
        expect(all).toHaveLength(2);
        const group = all.find((i) => i.collectionGroup)!;
        expect(['1', '4']).toContain(group.id);
        expect(group.collectionGroup).toMatchObject({ count: 2, total: 3, memberIds: ['1', '4'] });
      }
  });
});
