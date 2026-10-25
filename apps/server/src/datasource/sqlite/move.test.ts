import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { BadRequestError } from '../../http/errors.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { normalizeSubdir } from './move.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

describe('normalizeSubdir', () => {
  it.each([
    ['', ''],
    ['  角色\\未花\\ ', '角色/未花'],
    ['/a//b/', 'a/b'],
    ['结尾的点.', '结尾的点'],
  ])('%j → %j', (input, out) => expect(normalizeSubdir(input)).toBe(out));

  it.each(['..', 'a/../b', 'a:b', 'what?', 'CON', 'lpt1.txt', '.hidden', '$x', 'node_modules', '. .', '. ./sorted', 'a/. ./b', 'a/. . ', 'x/ .. . /y'])('%j 报错', (input) => {
    expect(() => normalizeSubdir(input)).toThrow(BadRequestError);
  });
});

/** 两个图库文件夹 + 真实文件；图片记录直接写库 */
describe('移动到文件夹（真的移动文件）', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const A = () => path.join(dir, 'A').replace(/\\/g, '/');
  const B = () => path.join(dir, 'B').replace(/\\/g, '/');
  const OLD = new Date('2023-05-01T00:00:00Z');

  const file = (root: string, rel: string) => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, rel);
    utimesSync(p, OLD, OLD);
  };
  const addImage = (id: number, root: number, rel: string, extra: { character?: number; collection?: number } = {}) => {
    const db = ds.ctx.db;
    db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at, collection_id)
       VALUES (?, ?, ?, ?, 1, 1, 1, 'png', ?, ?, ?, ?, ?)`,
    ).run(id, root, rel, rel.split('/').pop(), `s${id}`, OLD.toISOString(), OLD.toISOString(), OLD.toISOString(), extra.collection ?? null);
    if (extra.character) db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'manual', 'x')").run(id, extra.character);
  };
  const rowOf = (id: number) => ds.ctx.db.prepare('SELECT root_id, rel_path, file_name FROM images WHERE id = ?').get(id);

  beforeEach(async () => {
    dir = makeTmpDir('move');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?), (2, ?)').run(A(), B());
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (7, '圣园未花', 'custom', '2026-01-01T00:00:00Z')").run();
    file(A(), 'x/a.png');
    file(A(), 'x/b.png');
    file(B(), 'c.png');
    file(A(), '未花/b.png'); // 目标里已有同名文件
    file(A(), 'book/01.png');
    addImage(1, 1, 'x/a.png', { character: 7 });
    addImage(2, 1, 'x/b.png', { character: 7 });
    addImage(3, 2, 'c.png', { character: 7 });
    addImage(4, 1, 'book/01.png', { character: 7, collection: undefined });
    ds.ctx.db.prepare(
      "INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, created_at, updated_at) VALUES (9, 1, 'book', 'doujin', 'pages', 'auto', 'x', 'x')",
    ).run();
    ds.ctx.db.prepare('UPDATE images SET collection_id = 9 WHERE id = 4').run();
    ds.ctx.invalidate();
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('按角色移动：跨图库文件夹、重名加序号、合集不动、保留修改时间，可撤销', async () => {
    const r = await ds.moveImages({ characterId: '7', rootId: '1', dir: '未花' });
    expect(r.message).toBe(`已移动 3 张到 ${A()}/未花（合集里的 1 张没动）`);
    expect(rowOf(1)).toEqual({ root_id: 1, rel_path: '未花/a.png', file_name: 'a.png' });
    expect(rowOf(2)).toEqual({ root_id: 1, rel_path: '未花/b (1).png', file_name: 'b (1).png' });
    expect(rowOf(3)).toEqual({ root_id: 1, rel_path: '未花/c.png', file_name: 'c.png' });
    expect(rowOf(4)).toEqual({ root_id: 1, rel_path: 'book/01.png', file_name: '01.png' });
    expect(existsSync(path.join(A(), 'x/a.png'))).toBe(false);
    expect(existsSync(path.join(B(), 'c.png'))).toBe(false);
    expect(statSync(path.join(A(), '未花/c.png')).mtime.toISOString()).toBe(OLD.toISOString());
    // 识别结果还在
    expect((await ds.getImage('3'))!.characterIds).toEqual(['7']);

    await ds.undo(r.undoToken!);
    expect(rowOf(2)).toEqual({ root_id: 1, rel_path: 'x/b.png', file_name: 'b.png' });
    expect(rowOf(3)).toEqual({ root_id: 2, rel_path: 'c.png', file_name: 'c.png' });
    expect(existsSync(path.join(B(), 'c.png'))).toBe(true);
    expect(existsSync(path.join(A(), '未花/b (1).png'))).toBe(false);
    expect(existsSync(path.join(A(), '未花/b.png'))).toBe(true);
  });

  it('按选中的图移动到图库文件夹本身；已经在那里的跳过', async () => {
    const r = await ds.moveImages({ ids: ['3'], rootId: '2', dir: '' });
    expect(r).toMatchObject({ message: `已移动 0 张到 ${B()}（1 张本来就在这里）`, undoToken: null });
    const r2 = await ds.moveImages({ ids: ['1'], rootId: '2', dir: '' });
    expect(r2.message).toBe(`已移动 1 张到 ${B()}`);
    expect(rowOf(1)).toEqual({ root_id: 2, rel_path: 'a.png', file_name: 'a.png' });
  });

  it('移进被排除的文件夹：照规则排除', async () => {
    await ds.createExclusion({ kind: 'folder', target: `${A()}/表情包` });
    await ds.moveImages({ ids: ['1'], rootId: '1', dir: '表情包' });
    expect(ds.ctx.db.prepare('SELECT excluded_by IS NOT NULL FROM images WHERE id = 1').pluck().get()).toBe(1);
  });

  it('移进被排除的文件夹再撤销：移回原位就放出来；撤销前新建、原位置命中的规则照样排除', async () => {
    const db = ds.ctx.db;
    const excludedBy = (id: number) => db.prepare('SELECT excluded_by FROM images WHERE id = ?').pluck().get(id);
    const lastRule = () => db.prepare('SELECT max(id) FROM exclusions').pluck().get();
    await ds.createExclusion({ kind: 'folder', target: `${A()}/表情包` });
    const junk = lastRule();
    const r = await ds.moveImages({ ids: ['1', '3'], rootId: '1', dir: '表情包' });
    expect([excludedBy(1), excludedBy(3)]).toEqual([junk, junk]);
    // 这时 1 在表情包里，新规则跳过它；移回 x/ 之后要照这条规则排除
    await ds.createExclusion({ kind: 'folder', target: `${A()}/x` });
    const x = lastRule();
    await ds.undo(r.undoToken!);
    expect(rowOf(3)).toEqual({ root_id: 2, rel_path: 'c.png', file_name: 'c.png' });
    expect([excludedBy(1), excludedBy(3)]).toEqual([x, null]);
    expect((await ds.listExclusions()).find((e) => e.id === String(junk))!.imageCount).toBe(0);
  });

  it('文件不见了：报失败，记录不动', async () => {
    rmSync(path.join(A(), 'x/a.png'));
    const r = await ds.moveImages({ ids: ['1', '2'], rootId: '2', dir: 'y' });
    expect(r.message).toMatch(/^已移动 1 张到 .*（1 张移动失败：a\.png（ENOENT））$/);
    expect(rowOf(1)).toEqual({ root_id: 1, rel_path: 'x/a.png', file_name: 'a.png' });
  });

  it('移进漫画文件夹：识别器认的角色去掉、标重新识别；撤销后放回，角色这期间被删掉的不报错、留着重新识别', async () => {
    const db = ds.ctx.db;
    db.prepare("INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (1, 'C', 'general', 'x')").run();
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (8, 'A', 'custom', 'x')").run();
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (1, 8, 'tagger', 0.9, 'x')").run();
    // 识别过、没有角色的页：撤销后不该被标重新识别
    db.prepare('DELETE FROM image_characters WHERE image_id = 3').run();
    const state = (id: number) => ({
      kind: db.prepare('SELECT content_kind FROM images WHERE id = ?').pluck().get(id),
      retag: db.prepare('SELECT retag FROM images WHERE id = ?').pluck().get(id),
      chars: db.prepare('SELECT character_id || origin FROM image_characters WHERE image_id = ? ORDER BY 1').pluck().all(id),
    });
    const before = [state(1), state(3)];

    const r = await ds.moveImages({ ids: ['1', '3'], rootId: '1', dir: 'C' });
    expect(state(1)).toEqual({ kind: 'comic', retag: 1, chars: ['7manual'] });
    expect(state(3)).toMatchObject({ kind: 'comic', retag: 0 });
    await ds.undo(r.undoToken!);
    expect([state(1), state(3)]).toEqual(before);

    // 再移进去，期间角色 A 被删掉：撤销照常，那页留着重新识别
    const r2 = await ds.moveImages({ ids: ['1'], rootId: '1', dir: 'C' });
    db.prepare('DELETE FROM characters WHERE id = 8').run();
    await ds.undo(r2.undoToken!);
    expect(rowOf(1)).toEqual({ root_id: 1, rel_path: 'x/a.png', file_name: 'a.png' });
    expect(state(1)).toEqual({ kind: before[0]!.kind, retag: 1, chars: ['7manual'] });
  });

  it('停用的图库文件夹不能当目标', async () => {
    ds.ctx.db.prepare('UPDATE library_roots SET enabled = 0 WHERE id = 2').run();
    await expect(ds.moveImages({ ids: ['1'], rootId: '2', dir: '' })).rejects.toThrow('停用');
  });

  it('预览：数出会移的图、同时属于别的角色的张数；提交 ids 后只移确认过的这些', async () => {
    ds.ctx.db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (8, '早濑优香', 'custom', 'x')").run();
    ds.ctx.db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (1, 8, 'manual', 'x')").run();
    const p = await ds.previewMove({ characterId: '7', rootId: '1', dir: 'x' });
    expect(p).toEqual({ ids: ['3'], alreadyThere: 2, inCollection: 1, otherCharacters: 0 });
    const p2 = await ds.previewMove({ characterId: '7', rootId: '1', dir: '未花' });
    expect(p2).toEqual({ ids: ['1', '2', '3'], alreadyThere: 0, inCollection: 1, otherCharacters: 1 });
    // 预览之后角色又多了一张：只移对话框里确认过的
    file(A(), 'x/late.png');
    addImage(5, 1, 'x/late.png', { character: 7 });
    const r = await ds.moveImages({ ids: p2.ids, rootId: '1', dir: '未花' });
    expect(r.message).toBe(`已移动 3 张到 ${A()}/未花`);
    expect(rowOf(5)).toEqual({ root_id: 1, rel_path: 'x/late.png', file_name: 'late.png' });
    // 选中的图：两个及以上角色的算「同时属于别的角色」
    expect(await ds.previewMove({ ids: ['1', '5'], rootId: '2', dir: '' })).toMatchObject({ otherCharacters: 1 });
  });
});

/** 移动记录存在库里：重启后还能在「最近的移动」里移回原处，移不回的逐张说明 */
describe('移回原处（跨重启）', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const A = () => path.join(dir, 'A').replace(/\\/g, '/');
  const dataDir = () => path.join(dir, 'data');
  const open = () => SqliteDataSource.open(new EventBus(), dataDir(), { autoJobs: false, importDict: false });
  const rowOf = (id: number) => ds.ctx.db.prepare('SELECT root_id, rel_path FROM images WHERE id = ?').get(id);

  beforeEach(async () => {
    dir = makeTmpDir('moveback');
    ds = await open();
    const db = ds.ctx.db;
    db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(A());
    for (const [id, rel] of [[1, 'x/a.png'], [2, 'x/b.png'], [3, 'x/c.png']] as const) {
      mkdirSync(path.join(A(), 'x'), { recursive: true });
      writeFileSync(path.join(A(), rel), rel);
      db.prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x')`,
      ).run(id, rel, rel.split('/').pop(), `s${id}`);
    }
    ds.ctx.invalidate();
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('重启后移回；原位置被占的跳过并说明，腾出来后再移回剩下的', async () => {
    const r = await ds.moveImages({ ids: ['1', '2'], rootId: '1', dir: 'Z' });
    expect(r.undoToken).toEqual(expect.any(String));
    await ds.close();
    ds = await open();
    // 撤销栈随重启清空了，但记录还在
    expect(await ds.undoStatus([r.undoToken!])).toEqual({ [r.undoToken!]: 'expired' });
    const [entry] = await ds.listChanges('move');
    expect(entry).toMatchObject({ kind: 'move', count: 2, revertable: true, summary: `2 张移到 ${A()}/Z` });

    writeFileSync(path.join(A(), 'x/b.png'), '别的文件');
    const back = await ds.revertChange(entry!.id);
    expect(back).toEqual({ ok: true, message: '移回了 1 张；1 张没能移回：b.png（原位置已经有同名文件）', undoToken: null });
    expect(rowOf(1)).toEqual({ root_id: 1, rel_path: 'x/a.png' });
    expect(existsSync(path.join(A(), 'x/a.png'))).toBe(true);
    expect(rowOf(2)).toEqual({ root_id: 1, rel_path: 'Z/b.png' });
    expect((await ds.listChanges('move'))[0]).toMatchObject({ count: 1, revertable: true, note: '没能移回：b.png（原位置已经有同名文件）' });

    rmSync(path.join(A(), 'x/b.png'));
    expect((await ds.revertChange(entry!.id)).message).toBe('已把 1 张移回原处');
    expect(rowOf(2)).toEqual({ root_id: 1, rel_path: 'x/b.png' });
    expect(await ds.listChanges('move')).toEqual([expect.objectContaining({ revertable: false, count: 0, revertedAt: expect.any(String), note: null })]);
    await expect(ds.revertChange(entry!.id)).rejects.toThrow('已经撤回');
  });

  it('文件被删了、之后又移动过：一张都移不回时报错并逐张说明', async () => {
    await ds.moveImages({ ids: ['1', '2'], rootId: '1', dir: 'Z' });
    rmSync(path.join(A(), 'Z/a.png'));
    await ds.moveImages({ ids: ['2'], rootId: '1', dir: 'W' });
    const entry = (await ds.listChanges('move')).find((e) => e.summary.endsWith('/Z'))!;
    expect(entry.count).toBe(1);
    await expect(ds.revertChange(entry.id)).rejects.toThrow('移回了 0 张，2 张没能移回：b.png（之后又移动或改过名）、a.png（文件不在了）');
  });

  it('toast 里的撤销照样能用；在列表里移回后它就失效', async () => {
    const r = await ds.moveImages({ ids: ['3'], rootId: '1', dir: 'Z' });
    await ds.undo(r.undoToken!);
    expect(rowOf(3)).toEqual({ root_id: 1, rel_path: 'x/c.png' });
    expect((await ds.listChanges('move'))[0]).toMatchObject({ revertable: false });
    const r2 = await ds.moveImages({ ids: ['3'], rootId: '1', dir: 'Z' });
    await ds.revertChange((await ds.listChanges('move'))[0]!.id);
    await expect(ds.undo(r2.undoToken!)).rejects.toThrow('已经在「最近的移动」里移回原处了');
  });
});
