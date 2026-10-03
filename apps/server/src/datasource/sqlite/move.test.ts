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

  it.each(['..', 'a/../b', 'a:b', 'what?', 'CON', 'lpt1.txt', '.hidden', '$x', 'node_modules'])('%j 报错', (input) => {
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

  it('文件不见了：报失败，记录不动', async () => {
    rmSync(path.join(A(), 'x/a.png'));
    const r = await ds.moveImages({ ids: ['1', '2'], rootId: '2', dir: 'y' });
    expect(r.message).toMatch(/^已移动 1 张到 .*（1 张移动失败：a\.png（ENOENT））$/);
    expect(rowOf(1)).toEqual({ root_id: 1, rel_path: 'x/a.png', file_name: 'a.png' });
  });

  it('停用的图库文件夹不能当目标', async () => {
    ds.ctx.db.prepare('UPDATE library_roots SET enabled = 0 WHERE id = 2').run();
    await expect(ds.moveImages({ ids: ['1'], rootId: '2', dir: '' })).rejects.toThrow('停用');
  });
});
