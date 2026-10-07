import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../../services/image/sharpConfig.ts';
import { relUnder } from './roots.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

it('relUnder', () => {
  expect(relUnder('D:/', 'D:/a/b')).toBe('a/b');
  expect(relUnder('D:/x', 'D:/x/y')).toBe('y');
});

describe('添加父文件夹：合并已有的图库文件夹', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const P = () => path.join(dir, 'P').replace(/\\/g, '/');
  const sub = (name: string) => `${P()}/${name}`;
  const rootId = (p: string) => ds.ctx.db.prepare('SELECT id FROM library_roots WHERE path = ?').pluck().get(p) as number;
  const addImage = (id: number, root: number, rel: string) =>
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (?, ?, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x')`,
      )
      .run(id, root, rel, rel.split('/').pop(), `s${id}`);
  const rowOf = (id: number) => ds.ctx.db.prepare('SELECT root_id, rel_path FROM images WHERE id = ?').get(id);

  beforeEach(async () => {
    dir = makeTmpDir('merge');
    for (const d of ['C1', 'C2', 'C3', 'C1/deep']) mkdirSync(path.join(dir, 'P', d), { recursive: true });
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    await ds.addLibraryRoot({ path: sub('C1') });
    await ds.addLibraryRoot({ path: sub('C2') });
    await ds.addLibraryRoot({ path: sub('C3') });
    // 添加文件夹会排扫描：等它跑完再写夹具，免得扫描把下面写的记录当成丢失
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
    db.prepare("UPDATE library_roots SET imported_at = '2025-01-01T00:00:00.000Z'").run();
    await ds.updateLibraryRoot(String(rootId(sub('C2'))), { enabled: false });
    addImage(1, rootId(sub('C1')), 'a.png');
    addImage(2, rootId(sub('C1')), 'book/01.png');
    addImage(3, rootId(sub('C2')), 'b.png');
    addImage(4, rootId(sub('C3')), 'c.png');
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (7, '圣园未花', 'custom', 'x')").run();
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (1, 7, 'manual', 'x'), (4, 7, 'manual', 'x')").run();
    db.prepare(
      "INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, created_at, updated_at) VALUES (9, ?, 'book', 'doujin', 'manual', 'manual', 'x', 'x')",
    ).run(rootId(sub('C1')));
    db.prepare("INSERT INTO scan_errors (root_id, rel_path, bytes, modified_at, error, at) VALUES (?, 'bad.png', 1, 'x', 'e', 'x')").run(rootId(sub('C1')));
    // C3 以前移除过
    await ds.removeLibraryRoot(String(rootId(sub('C3'))));
    ds.ctx.invalidate();
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('先问；确认后改写路径，整理结果都在，移除过的也接管回来', async () => {
    await expect(ds.addLibraryRoot({ path: P() })).rejects.toMatchObject({
      code: 'needs_confirm',
      message: `这个文件夹包含图库里已有的「${sub('C1')}」「${sub('C2')}」，合并成一个吗？原来的识别和整理结果都会保留。其中「${sub('C2')}」现在是停用的，合并后会重新显示。`,
    });
    const r = await ds.addLibraryRoot({ path: P(), merge: true });
    // 合并后会排一次扫描（测试里文件不存在，扫描会清掉读取失败记录），先同步取出来
    const p = rootId(P());
    expect(ds.ctx.db.prepare('SELECT root_id, rel_path FROM scan_errors').get()).toEqual({ root_id: p, rel_path: 'C1/bad.png' });
    expect(r.message).toBe(`已合并成一个文件夹（保留了 4 张图的整理结果），开始扫描其余部分：${P()}`);

    expect((await ds.getSettings()).libraryRoots.map((x) => [x.path, x.enabled, x.importedAt])).toEqual([[P(), true, '2025-01-01T00:00:00.000Z']]);
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM library_roots').pluck().get()).toBe(1);
    expect([1, 2, 3, 4].map(rowOf)).toEqual([
      { root_id: p, rel_path: 'C1/a.png' },
      { root_id: p, rel_path: 'C1/book/01.png' },
      { root_id: p, rel_path: 'C2/b.png' },
      { root_id: p, rel_path: 'C3/c.png' },
    ]);
    expect((await ds.getImage('4'))!.characterIds).toEqual(['7']);
    expect(ds.ctx.db.prepare('SELECT root_id, rel_dir FROM collections').get()).toEqual({ root_id: p, rel_dir: 'C1/book' });
    expect(existsSync(path.join(dir, 'data', 'emaki.before-merge.bak.sqlite'))).toBe(true);
  });

  it('只包含移除过的文件夹：不用问，直接接管', async () => {
    await ds.removeLibraryRoot(String(rootId(sub('C1'))));
    await ds.removeLibraryRoot(String(rootId(sub('C2'))));
    const r = await ds.addLibraryRoot({ path: P() });
    expect(r.message).toBe(`已添加文件夹，开始扫描：${P()}`);
    expect(rowOf(1)).toEqual({ root_id: rootId(P()), rel_path: 'C1/a.png' });
  });

  it('子文件夹：提示已经包含在哪里', async () => {
    await ds.addLibraryRoot({ path: P(), merge: true });
    await expect(ds.addLibraryRoot({ path: `${sub('C1')}/deep` })).rejects.toThrow(`已经包含在「${P()}」里了，不用单独添加`);
  });

  it('父文件夹以前移除过、又有同路径的旧记录：还在用的子文件夹的记录留下', async () => {
    await ds.addLibraryRoot({ path: P(), merge: true });
    const p = rootId(P());
    await ds.removeLibraryRoot(String(p));
    // 父文件夹移除后又单独加了 C1，里面同一张图有了新记录
    await ds.addLibraryRoot({ path: sub('C1') });
    addImage(10, rootId(sub('C1')), 'a.png');
    await ds.addLibraryRoot({ path: P(), merge: true });
    expect(rootId(P())).toBe(p);
    expect(rowOf(10)).toEqual({ root_id: p, rel_path: 'C1/a.png' });
    expect(rowOf(1)).toBeUndefined();
    expect(rowOf(4)).toEqual({ root_id: p, rel_path: 'C3/c.png' });
  });
});

describe('按漫画导入', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const idle = async () => {
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
  };
  beforeEach(async () => {
    dir = makeTmpDir('comic');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('添加时选漫画：每卷一本本子、都归漫画、不等识别；改回插画后要识别，可撤销', async () => {
    const M = path.join(dir, '某漫画');
    const files: [string, number][] = [
      ['某漫画 Vol.01/pics/p-0.png', 1],
      ['某漫画 Vol.01/pics/p-1.png', 2],
      ['某漫画 Vol.02/2卷/a.png', 3],
      ['某漫画 Vol.02/2卷/b.png', 4],
    ];
    const old = new Date('2025-01-01');
    for (const [rel, seed] of files) {
      const p = path.join(M, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 100, b: 100 } } }).png().toFile(p);
      utimesSync(p, old, old);
    }
    await ds.addLibraryRoot({ path: M.replace(/\\/g, '/'), mode: 'comic', comicRating: 'sensitive' });
    await idle();
    const s = await ds.getStats();
    expect([s.imageCount, s.kindCounts.comic, s.pendingTagCount, s.unrecognizedCount]).toEqual([4, 4, 0, 0]);
    const books = await ds.listCollections({ kind: 'doujin' });
    expect(books.map((b) => [b.title, b.seriesKey, b.volumeNo, b.pageCount, b.pending, b.coverTagged])).toEqual([
      ['某漫画', '某漫画', 1, 2, false, true],
      ['某漫画', '某漫画', 2, 2, false, true],
    ]);
    const page = (await ds.getCollection(books[0]!.id))!.pages[0]!;
    expect(page).toMatchObject({ kind: 'comic', rating: 'sensitive', tagged: true });

    const root = (await ds.getSettings()).libraryRoots[0]!;
    expect(root).toMatchObject({ mode: 'comic', comicRating: 'sensitive' });
    const r = await ds.updateLibraryRoot(root.id, { mode: 'auto' });
    expect((await ds.getStats()).pendingTagCount).toBe(4);
    expect(await ds.listCollections({ kind: 'doujin' })).toEqual([]);
    await ds.undo(r.undoToken!);
    expect((await ds.getStats()).pendingTagCount).toBe(0);
    expect((await ds.listCollections({ kind: 'doujin' })).map((b) => b.volumeNo)).toEqual([1, 2]);

    // 改回插画后有一页识别过了（分级 explicit），再撤销：这页的识别结果不被盖回旧快照，类型回到漫画
    const db = ds.ctx.db;
    const r2 = await ds.updateLibraryRoot(root.id, { mode: 'auto' });
    const pageId = db.prepare("SELECT id FROM images WHERE file_name = 'a.png'").pluck().get() as number;
    db.prepare("UPDATE images SET tagged_at = 'x', rating = 'explicit', content_kind = 'illustration', content_kind_source = 'tags' WHERE id = ?").run(pageId);
    await ds.undo(r2.undoToken!);
    expect(db.prepare('SELECT content_kind, rating FROM images WHERE id = ?').get(pageId)).toEqual({ content_kind: 'comic', rating: 'explicit' });
    expect(db.prepare("SELECT DISTINCT rating FROM images WHERE tagged_at IS NULL").pluck().all()).toEqual(['sensitive']);

    // 只撤销停用：导入方式不跟着变
    await ds.updateLibraryRoot(root.id, { comicRating: 'general' });
    const off = await ds.updateLibraryRoot(root.id, { enabled: false });
    await ds.updateLibraryRoot(root.id, { mode: 'auto' });
    await ds.undo(off.undoToken!);
    expect((await ds.getSettings()).libraryRoots[0]).toMatchObject({ enabled: true, mode: 'auto' });
  });

  it('添加后、扫描前改成漫画：扫描结束时按现在的设置判；漫画文件夹根目录直接放的页也成一本', async () => {
    const M = path.join(dir, '单行本');
    mkdirSync(M, { recursive: true });
    const old = new Date('2025-01-01');
    for (const seed of [1, 2, 3]) {
      const p = path.join(M, `${seed}.png`);
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 30, g: 50, b: 50 } } }).png().toFile(p);
      utimesSync(p, old, old);
    }
    await ds.addLibraryRoot({ path: M.replace(/\\/g, '/') });
    // 扫描排上了但还没跑完就改了导入方式（扫描按开始时读到的设置判，结束时 syncRootModes 再纠正）
    ds.ctx.db.prepare("UPDATE library_roots SET content_mode = 'comic', comic_rating = 'questionable'").run();
    await idle();
    expect(ds.ctx.db.prepare('SELECT DISTINCT content_kind, rating FROM images').all()).toEqual([{ content_kind: 'comic', rating: 'questionable' }]);
    const books = await ds.listCollections({ kind: 'doujin' });
    expect(books.map((b) => [b.title, b.pageCount, b.pending])).toEqual([['单行本', 3, false]]);
    expect((await ds.unrecognizedSummary()).art.total).toBe(0);
  });
});
