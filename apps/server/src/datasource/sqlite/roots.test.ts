import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../../services/image/sharpConfig.ts';
import { relUnder } from './roots.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';
import { syncRootModes } from '../../services/classify/rootMode.ts';

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
    expect(r.message).toBe(`已添加文件夹（找回了 4 张图以前的整理结果），开始扫描：${P()}`);
    expect(rowOf(1)).toEqual({ root_id: rootId(P()), rel_path: 'C1/a.png' });
  });

  it('子文件夹：提示已经包含在哪里', async () => {
    await ds.addLibraryRoot({ path: P(), merge: true });
    await expect(ds.addLibraryRoot({ path: `${sub('C1')}/deep` })).rejects.toThrow(`已经包含在「${P()}」里了，不用单独添加`);
  });

  it('父文件夹移除后单独加回里面的子文件夹：接管旧记录（id 和整理结果都在）；再加回父文件夹时合并回去', async () => {
    const idle = async () => {
      while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
    };
    const colls = () => ds.ctx.db.prepare('SELECT id, root_id, rel_dir FROM collections').all();
    await ds.addLibraryRoot({ path: P(), merge: true });
    await idle();
    const p = rootId(P());
    await ds.removeLibraryRoot(String(p));
    const r = await ds.addLibraryRoot({ path: sub('C1') });
    const c1 = rootId(sub('C1'));
    expect(r.message).toBe(`已添加文件夹（找回了 2 张图以前的整理结果），开始扫描：${sub('C1')}`);
    expect([1, 2, 4].map(rowOf)).toEqual([
      { root_id: c1, rel_path: 'a.png' },
      { root_id: c1, rel_path: 'book/01.png' },
      { root_id: p, rel_path: 'C3/c.png' },
    ]);
    expect(colls()).toEqual([{ id: 9, root_id: c1, rel_dir: 'book' }]);
    expect(ds.ctx.db.prepare('SELECT character_id FROM image_characters WHERE image_id = 1').pluck().all()).toEqual([7]);
    // 接管回来的图不算刚导入
    expect(ds.ctx.db.prepare('SELECT imported_at FROM library_roots WHERE id = ?').pluck().get(c1)).toBe('2025-01-01T00:00:00.000Z');
    await idle();

    // 父文件夹里又有一条和 C1 同路径的记录（冲突）：还在用的 C1 的记录留下
    addImage(10, p, 'C1/x.png');
    addImage(11, c1, 'x.png');
    await ds.addLibraryRoot({ path: P(), merge: true });
    expect(rootId(P())).toBe(p);
    expect([1, 2, 4, 11].map(rowOf)).toEqual([
      { root_id: p, rel_path: 'C1/a.png' },
      { root_id: p, rel_path: 'C1/book/01.png' },
      { root_id: p, rel_path: 'C3/c.png' },
      { root_id: p, rel_path: 'C1/x.png' },
    ]);
    expect(rowOf(10)).toBeUndefined();
    expect(colls()).toEqual([{ id: 9, root_id: p, rel_dir: 'C1/book' }]);
  });
});

describe('移除、停用后再显示：合集 id 和页码不变，重复组找回来', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const idle = async () => {
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
  };
  beforeEach(async () => {
    dir = makeTmpDir('reshow');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('移除后撤销、停用后启用（或撤销停用）、移除后重新添加', async () => {
    const R = path.join(dir, '某漫画');
    const old = new Date('2025-01-01');
    // 两卷各两页；Vol.02 的两页是同一个文件（完全重复）
    for (const [rel, seed] of [
      ['某漫画 Vol.01/1.png', 1],
      ['某漫画 Vol.01/2.png', 2],
      ['某漫画 Vol.02/1.png', 3],
      ['某漫画 Vol.02/2.png', 3],
    ] as const) {
      const p = path.join(R, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 100, b: 100 } } }).png().toFile(p);
      utimesSync(p, old, old);
    }
    const rootPath = R.replace(/\\/g, '/');
    await ds.addLibraryRoot({ path: rootPath, mode: 'comic' });
    await idle();
    // 扫描后已经自动查过一次重（任务链里的「需要查重」标记清掉了，下面不会顺带再查）
    expect((await ds.listJobs()).map((j) => [j.kind, j.status])).toContainEqual(['dedupe', 'done']);
    const db = ds.ctx.db;
    ds.dedupe.runOnce();
    const root = (await ds.getSettings()).libraryRoots[0]!.id;
    const state = () => [db.prepare('SELECT id, rel_dir FROM collections ORDER BY id').all(), db.prepare('SELECT id, collection_id, page_no FROM images ORDER BY id').all()];
    const groups = () => db.prepare('SELECT COUNT(*) FROM duplicate_groups WHERE resolved_at IS NULL').pluck().get();
    const before = state();
    expect(before[0]).toHaveLength(2);
    expect(groups()).toBe(1);
    // 文件夹隐藏期间跑过查重：它的未处理组在对账时被删掉，再显示后要自动找回来
    const dedupeWhileHidden = () => {
      ds.dedupe.runOnce();
      expect(groups()).toBe(0);
    };
    const shownAgain = async () => {
      await idle();
      expect(state()).toEqual(before);
      expect(groups()).toBe(1);
    };

    const rm1 = await ds.removeLibraryRoot(root);
    // 隐藏期间按 id 也找不到、改不了
    const book = String((before[0] as { id: number }[])[0]!.id);
    expect(await ds.listCollections({})).toEqual([]);
    expect(await ds.getCollection(book)).toBeNull();
    await expect(ds.updateCollection(book, { title: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    dedupeWhileHidden();
    await ds.undo(rm1.undoToken!);
    await shownAgain();

    const off = await ds.updateLibraryRoot(root, { enabled: false });
    dedupeWhileHidden();
    await ds.undo(off.undoToken!);
    await shownAgain();

    await ds.updateLibraryRoot(root, { enabled: false });
    dedupeWhileHidden();
    await ds.updateLibraryRoot(root, { enabled: true });
    await shownAgain();

    await ds.removeLibraryRoot(root);
    dedupeWhileHidden();
    await ds.addLibraryRoot({ path: rootPath, mode: 'comic' });
    await shownAgain();
  });

  it('移除父文件夹后单独加回一本书的文件夹：这本合集接管过来（id 和手改的标题不变）', async () => {
    const lib = path.join(dir, 'lib');
    const old = new Date('2025-01-01');
    let seed = 0;
    for (const rel of ['漫画/Vol.01/1.png', '漫画/Vol.01/2.png', '漫画/Vol.02/1.png']) {
      const p = path.join(lib, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      seed++;
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 100, b: 100 } } }).png().toFile(p);
      utimesSync(p, old, old);
    }
    const fwd = (p: string) => p.replace(/\\/g, '/');
    await ds.addLibraryRoot({ path: fwd(lib), mode: 'comic' });
    await idle();
    const db = ds.ctx.db;
    const book = db.prepare("SELECT id FROM collections WHERE rel_dir = '漫画/Vol.01'").pluck().get() as number;
    db.prepare("UPDATE collections SET title = '手改的标题', title_manual = 1 WHERE id = ?").run(book);
    const pages = db.prepare('SELECT id FROM images WHERE collection_id = ? ORDER BY page_no').pluck().all(book);
    expect(pages).toHaveLength(2);

    await ds.removeLibraryRoot((await ds.getSettings()).libraryRoots[0]!.id);
    await idle();
    await ds.addLibraryRoot({ path: fwd(path.join(lib, '漫画', 'Vol.01')), mode: 'comic' });
    await idle();
    expect((await ds.listCollections({})).map((c) => [c.id, c.title])).toEqual([[String(book), '手改的标题']]);
    expect(db.prepare('SELECT rel_dir FROM collections WHERE id = ?').pluck().get(book)).toBe('');
    expect(db.prepare('SELECT id FROM images WHERE collection_id = ? ORDER BY page_no').pluck().all(book)).toEqual(pages);
  });
});

describe('同一个文件夹换种写法（联接点、\\\\?\\ 前缀）', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const at = (...s: string[]) => path.join(dir, ...s);
  const roots = () => ds.ctx.db.prepare('SELECT id, path FROM library_roots').all() as { id: number; path: string }[];
  beforeEach(async () => {
    dir = makeTmpDir('spell');
    mkdirSync(at('Pics', 'sub'), { recursive: true });
    mkdirSync(at('data'), { recursive: true });
    symlinkSync(at('Pics'), at('PicsLink'), 'junction');
    symlinkSync(at('data'), at('DataLink'), 'junction');
    ds = await SqliteDataSource.open(new EventBus(), at('data'), { memory: true, autoJobs: false, importDict: false });
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')('认成已有的文件夹或它的子文件夹，不重复加', async () => {
    await ds.addLibraryRoot({ path: at('Pics') });
    await expect(ds.addLibraryRoot({ path: at('PicsLink') })).rejects.toThrow('这个文件夹已经在图库里了');
    await expect(ds.addLibraryRoot({ path: `\\\\?\\${at('Pics')}` })).rejects.toThrow('这个文件夹已经在图库里了');
    await expect(ds.addLibraryRoot({ path: at('PicsLink', 'sub') })).rejects.toThrow('已经包含在');
    expect(roots()).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('数据目录换种写法也不能加', async () => {
    for (const p of [`\\\\?\\${at('data')}`, at('DataLink'), at('DataLink', '..')]) {
      await expect(ds.addLibraryRoot({ path: p })).rejects.toThrow('不能把 Emaki 的数据目录加入图库');
    }
    expect(roots()).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('\\\\?\\ 写法存成普通路径', async () => {
    await ds.addLibraryRoot({ path: `\\\\?\\${at('Pics')}` });
    expect(roots().map((r) => r.path.toLowerCase())).toEqual([at('Pics').replace(/\\/g, '/').toLowerCase()]);
  });

  it.skipIf(process.platform !== 'win32')('先按联接点加了子文件夹，再加父文件夹：认出来合并，相对路径按真实位置算', async () => {
    await ds.addLibraryRoot({ path: at('PicsLink', 'sub') });
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
    const child = roots()[0]!.id;
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (1, ?, 'a.png', 'a.png', 1, 1, 1, 'png', 's1', 'x', 'x')`,
      )
      .run(child);
    await expect(ds.addLibraryRoot({ path: at('Pics') })).rejects.toMatchObject({ code: 'needs_confirm' });
    await ds.addLibraryRoot({ path: at('Pics'), merge: true });
    const [root] = roots();
    expect(roots()).toHaveLength(1);
    expect(ds.ctx.db.prepare('SELECT root_id, rel_path FROM images WHERE id = 1').get()).toEqual({ root_id: root!.id, rel_path: 'sub/a.png' });
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

  it('已有图库文件夹里面的子文件夹按漫画导入：只有它归漫画、每卷一本；去掉后恢复识别；可撤销', async () => {
    const R = path.join(dir, '收藏');
    const old = new Date('2025-01-01');
    const put = async (rel: string, seed: number) => {
      const p = path.join(R, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 80, b: 120 } } }).png().toFile(p);
      utimesSync(p, old, old);
    };
    await put('插画/a.png', 1);
    await put('漫画/某漫画/某漫画 Vol.01/1.png', 2);
    await put('漫画/某漫画/某漫画 Vol.01/2.png', 3);
    await put('漫画/某漫画/某漫画 Vol.02/1.png', 4);
    await put('漫画/某漫画/某漫画 Vol.02/2.png', 5);
    const rootPath = R.replace(/\\/g, '/');
    await ds.addLibraryRoot({ path: rootPath });
    await idle();
    expect((await ds.getStats()).pendingTagCount).toBe(5);

    // 再「添加」里面的子文件夹并选漫画：不另加图库文件夹，而是把它按漫画导入
    const r = await ds.addLibraryRoot({ path: `${rootPath}/漫画/某漫画`, mode: 'comic', comicRating: 'sensitive' });
    expect(r.message).toBe(`已把「${rootPath}/漫画/某漫画」按漫画导入：4 张归到漫画，不再识别`);
    const s = await ds.getSettings();
    expect(s.libraryRoots).toHaveLength(1);
    expect(s.libraryRoots[0]).toMatchObject({ mode: 'auto', comicFolders: [{ relDir: '漫画/某漫画', comicRating: 'sensitive' }] });
    expect((await ds.getStats()).pendingTagCount).toBe(1);
    const books = await ds.listCollections({ kind: 'doujin' });
    expect(books.map((b) => [b.title, b.volumeNo, b.pageCount, b.pending])).toEqual([
      ['某漫画', 1, 2, false],
      ['某漫画', 2, 2, false],
    ]);
    const kinds = () => ds.ctx.db.prepare('SELECT file_name || rel_path AS k, content_kind, rating FROM images ORDER BY rel_path').all();
    expect((kinds() as { content_kind: string }[]).map((x) => x.content_kind)).toEqual(['illustration', 'comic', 'comic', 'comic', 'comic']);
    // 里面再加一层：已经在漫画里了
    await expect(ds.addLibraryRoot({ path: `${rootPath}/漫画/某漫画/某漫画 Vol.01`, mode: 'comic' })).rejects.toMatchObject({ statusCode: 400 });
    // 不选漫画添加子文件夹：照旧提示已经包含
    await expect(ds.addLibraryRoot({ path: `${rootPath}/插画` })).rejects.toMatchObject({ statusCode: 400 });

    const off = await ds.updateLibraryRoot(s.libraryRoots[0]!.id, { removeComicFolder: '漫画/某漫画' });
    expect(off.message).toBe(`「${rootPath}/漫画/某漫画」不再按漫画导入：没识别过的图会开始识别`);
    expect((await ds.getStats()).pendingTagCount).toBe(5);
    expect(await ds.listCollections({ kind: 'doujin' })).toEqual([]);
    await ds.undo(off.undoToken!);
    expect((await ds.getStats()).pendingTagCount).toBe(1);
    expect((await ds.listCollections({ kind: 'doujin' })).length).toBe(2);
    await ds.undo(r.undoToken!);
    expect((await ds.getSettings()).libraryRoots[0]!.comicFolders).toEqual([]);
    expect((await ds.getStats()).pendingTagCount).toBe(5);
  });

  it('漫画子文件夹：手输大小写不对也能认；磁盘上改名后跟过去；先撤里层、外层还在时页还是漫画', async () => {
    const R = path.join(dir, '收藏');
    const old = new Date('2025-01-01');
    const put = async (rel: string, seed: number) => {
      const p = path.join(R, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 80, b: 120 } } }).png().toFile(p);
      utimesSync(p, old, old);
    };
    await put('Manga/Foo/v1/1.png', 1);
    await put('Manga/Foo/v1/2.png', 2);
    await put('Manga/Foo/v2/1.png', 3);
    await put('Manga/Foo/v2/2.png', 4);
    const rootPath = R.replace(/\\/g, '/');
    await ds.addLibraryRoot({ path: rootPath });
    await idle();
    const db = ds.ctx.db;
    const kinds = () => db.prepare('SELECT DISTINCT content_kind FROM images').pluck().all();

    // Windows 上路径不分大小写：按磁盘上的名字记
    if (process.platform === 'win32') {
      const r = await ds.addLibraryRoot({ path: `${rootPath}/manga/foo`, mode: 'comic' });
      expect(r.message).toContain('4 张归到漫画');
      expect((await ds.getSettings()).libraryRoots[0]!.comicFolders).toEqual([{ relDir: 'Manga/Foo', comicRating: 'general' }]);
    } else {
      await ds.addLibraryRoot({ path: `${rootPath}/Manga/Foo`, mode: 'comic' });
    }
    expect(kinds()).toEqual(['comic']);

    // 整个文件夹在磁盘上改名：扫描后设置跟过去，页还是漫画、不进识别
    renameSync(path.join(R, 'Manga/Foo'), path.join(R, 'Manga/Bar'));
    await ds.startJob('scan');
    await idle();
    expect((await ds.getSettings()).libraryRoots[0]!.comicFolders).toEqual([{ relDir: 'Manga/Bar', comicRating: 'general' }]);
    expect(kinds()).toEqual(['comic']);
    expect((await ds.getStats()).pendingTagCount).toBe(0);

    // 先把整个 Manga 设成漫画（外层），再撤销里层 Bar：Bar 的页还在外层里，还是漫画、用外层的分级
    const rootId = (await ds.getSettings()).libraryRoots[0]!.id;
    await ds.updateLibraryRoot(rootId, { removeComicFolder: 'Manga/Bar' });
    const inner = await ds.updateLibraryRoot(rootId, { comicFolder: { relDir: 'Manga/Bar/v1', comicRating: 'sensitive' } });
    await ds.updateLibraryRoot(rootId, { comicFolder: { relDir: 'Manga', comicRating: 'questionable' } });
    await ds.undo(inner.undoToken!);
    expect(db.prepare("SELECT DISTINCT content_kind || ' ' || rating FROM images").pluck().all()).toEqual(['comic questionable']);
  });

  it('改成漫画前识别过的页：识别器认的角色清掉并标重新识别、手动加的留着；都能撤销', async () => {
    const R = path.join(dir, '收藏');
    const old = new Date('2025-01-01');
    for (const [rel, seed] of [['某漫画/v1/1.png', 1], ['某漫画/v1/2.png', 2]] as const) {
      const p = path.join(R, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 80, b: 120 } } }).png().toFile(p);
      utimesSync(p, old, old);
    }
    const rootPath = R.replace(/\\/g, '/');
    await ds.addLibraryRoot({ path: rootPath });
    await idle();
    const db = ds.ctx.db;
    // 两页都识别过：第一页被误认成 A（识别器），第二页用户手动加了 B
    const [p1, p2] = db.prepare('SELECT id FROM images ORDER BY rel_path').pluck().all() as number[];
    db.prepare("UPDATE images SET tagged_at = 'x', tagger_model = 'm'").run();
    db.prepare("INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (901, 'A', 'a_(x)', 'danbooru', 'x'), (902, 'B', 'b_(x)', 'custom', 'x')").run();
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, 901, 'tagger', 0.9, 'x'), (?, 902, 'manual', NULL, 'x')").run(p1, p2);
    const links = () => db.prepare('SELECT image_id, character_id, origin FROM image_characters ORDER BY image_id').all();
    const retag = () => db.prepare('SELECT retag FROM images ORDER BY rel_path').pluck().all();
    const before = links();
    const rootId = (await ds.getSettings()).libraryRoots[0]!.id;

    const on = await ds.updateLibraryRoot(rootId, { comicFolder: { relDir: '某漫画', comicRating: 'general' } });
    // 清掉角色的那页标重新识别（在漫画里识别任务不领，离开后才认），只剩手动角色的那页不用
    expect(links()).toEqual([{ image_id: p2, character_id: 902, origin: 'manual' }]);
    expect(retag()).toEqual([1, 0]);
    expect((await ds.getStats()).pendingTagCount).toBe(0);
    await ds.undo(on.undoToken!);
    expect(links()).toEqual(before);
    expect(retag()).toEqual([0, 0]);

    // 再改成漫画，然后去掉：标记留着，识别任务会去重新认那一页
    await ds.updateLibraryRoot(rootId, { comicFolder: { relDir: '某漫画', comicRating: 'general' } });
    const off = await ds.updateLibraryRoot(rootId, { removeComicFolder: '某漫画' });
    expect(retag()).toEqual([1, 0]);
    await ds.undo(off.undoToken!);
    expect(retag()).toEqual([1, 0]);

    // 扫描结束后的全库检查也会清（升级前就改成漫画的库）
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, 901, 'tagger', 0.9, 'x')").run(p1);
    expect(syncRootModes(db)).toBeGreaterThan(0);
    expect(links()).toEqual([{ image_id: p2, character_id: 902, origin: 'manual' }]);
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

describe('移除的图库文件夹：重启后不清掉，30 天内重新添加能找回', () => {
  let dir: string;
  let ds: SqliteDataSource;
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const DAY = 86_400_000;
  const open = () => SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { autoJobs: false, importDict: false, clock: () => now });
  const idle = async () => {
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
  };
  beforeEach(() => {
    dir = makeTmpDir('removed-keep');
    mkdirSync(path.join(dir, 'Lib'));
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('重启后整理结果还在，重新添加找回；超过 30 天的启动时才清掉', async () => {
    const lib = path.join(dir, 'Lib').replace(/\\/g, '/');
    ds = await open();
    await ds.addLibraryRoot({ path: lib });
    await idle();
    const db = () => ds.ctx.db;
    const root = db().prepare('SELECT id FROM library_roots').pluck().get() as number;
    db()
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, favorite)
         VALUES (1, ?, 'a.png', 'a.png', 1, 1, 1, 'png', 's1', 'x', 'x', 1)`,
      )
      .run(root);
    db().prepare("INSERT INTO characters (id, name, source, created_at) VALUES (7, '圣园未花', 'custom', 'x')").run();
    db().prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (1, 7, 'manual', 'x')").run();
    ds.ctx.invalidate();
    const r = await ds.removeLibraryRoot(String(root));
    expect(r.message).toBe(`已移除文件夹：${lib}。磁盘上的文件没动，30 天内重新添加它能找回整理结果`);
    await ds.close();

    // 10 天后重启：没清
    now += 10 * DAY;
    ds = await open();
    expect(db().prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(1);
    expect((await ds.getSettings()).libraryRoots).toEqual([]);
    expect(await ds.getImage('1')).toBeNull();
    const added = await ds.addLibraryRoot({ path: lib });
    expect(added.message).toBe(`已添加文件夹（找回了 1 张图以前的整理结果），开始扫描：${lib}`);
    expect(await ds.getImage('1')).toMatchObject({ favorite: true, characterIds: ['7'] });
    await idle();

    // 再移除，31 天后重启：清掉
    await ds.removeLibraryRoot(String(root));
    await ds.close();
    now += 31 * DAY;
    ds = await open();
    expect(db().prepare('SELECT COUNT(*) FROM library_roots').pluck().get()).toBe(0);
    expect(db().prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0);
  });
});
