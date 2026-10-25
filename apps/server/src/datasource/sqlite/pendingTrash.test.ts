import { existsSync, mkdirSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { TRASH_COMMITTED } from '../../core/undo.ts';
import { closeDatabase } from '../../db/connection.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { sharp } from '../../services/image/sharpConfig.ts';
import { SqliteDataSource, type SqliteOpenOptions } from './SqliteDataSource.ts';

describe('移到回收站延后执行（pending_trash）', () => {
  let dir: string;
  let lib: string;
  let ds: SqliteDataSource;
  let moved: string[];
  // 假回收站：记下来再删掉
  const trashImpl = async (paths: string[]) => {
    for (const p of paths) {
      moved.push(path.basename(p));
      unlinkSync(p);
    }
  };
  const opts = (): SqliteOpenOptions => ({ autoJobs: false, importDict: false, trashImpl, checkRecyclable: async () => {} });
  const idle = async () => {
    while ((await ds.listJobs()).some((j) => j.status === 'queued' || j.status === 'running')) await new Promise((r) => setTimeout(r, 10));
  };
  const put = async (name: string, seed: number) => {
    const p = path.join(lib, name);
    await sharp({ create: { width: 40 + seed, height: 60, channels: 3, background: { r: seed * 20, g: 90, b: 150 } } }).png().toFile(p);
    const old = new Date('2025-01-01');
    utimesSync(p, old, old);
  };
  const idOf = (name: string) => String(ds.ctx.db.prepare('SELECT id FROM images WHERE file_name = ?').pluck().get(name));
  const trash = (name: string) => ds.bulkImages({ ids: [idOf(name)], action: { type: 'trash' } });
  const onDisk = (name: string) => existsSync(path.join(lib, name));
  const names = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'h.png', 'i.png'];

  beforeEach(async () => {
    dir = makeTmpDir('pending-trash');
    lib = path.join(dir, 'lib');
    mkdirSync(lib);
    moved = [];
    for (const [i, n] of names.entries()) await put(n, i + 1);
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), opts());
    await ds.addLibraryRoot({ path: lib.replace(/\\/g, '/') });
    await idle();
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('前 5 次文件不动、可撤销；第 6 次把最早的一次真的移进回收站，它的撤销作废', async () => {
    const results = [];
    for (const n of names.slice(0, 5)) results.push(await trash(n));
    expect(results.every((r) => r.undoToken && !r.expiredUndoTokens)).toBe(true);
    await ds.pendingTrash.idle();
    expect(moved).toEqual([]);
    expect(names.slice(0, 5).every(onDisk)).toBe(true);

    const sixth = await trash('f.png');
    const first = results[0]!.undoToken!;
    expect(sixth.expiredUndoTokens).toEqual([first]);
    expect(await ds.undoStatus([first, results[1]!.undoToken!])).toEqual({ [first]: 'expired', [results[1]!.undoToken!]: 'live' });
    await expect(ds.undo(first)).rejects.toMatchObject({ code: 'not_found', message: TRASH_COMMITTED });
    await ds.pendingTrash.idle();
    expect(moved).toEqual(['a.png']);
    expect(onDisk('b.png')).toBe(true);

    // 第 2 次还能撤销，图回来
    await ds.undo(results[1]!.undoToken!);
    expect((await ds.getImage(idOf('b.png')))).not.toBeNull();
    // 撤销掉的不占位置：再来一次不会挤掉第 3 次
    const again = await trash('g.png');
    expect(again.expiredUndoTokens).toBeUndefined();
  });

  it('扫描不会把还没移走的图当成恢复或改动', async () => {
    await trash('a.png');
    await ds.startJob('scan');
    await idle();
    expect(ds.ctx.db.prepare("SELECT trashed_at IS NOT NULL FROM images WHERE file_name = 'a.png'").pluck().get()).toBe(1);
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(names.length);
  });

  it('正常退出时把剩下的都移进回收站', async () => {
    await trash('a.png');
    await trash('b.png');
    await ds.close();
    expect(moved.sort()).toEqual(['a.png', 'b.png']);
    expect(onDisk('c.png')).toBe(true);
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), opts());
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM pending_trash').pluck().get()).toBe(0);
  });

  it('上次被强杀留下的，启动时移走；移不动的只记日志，图仍在回收站状态', async () => {
    await trash('a.png');
    await trash('b.png');
    // 不走 close()：直接关库，模拟进程被杀
    closeDatabase(ds.ctx.db);
    const locked = path.join(lib, 'b.png');
    const failing = async (paths: string[]) => trashImpl(paths.filter((p) => p !== locked));
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { ...opts(), trashImpl: failing });
    await ds.pendingTrash.idle();
    expect(moved).toEqual(['a.png']);
    expect(onDisk('b.png')).toBe(true);
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM pending_trash').pluck().get()).toBe(0);
    expect(ds.ctx.db.prepare("SELECT trashed_at IS NOT NULL FROM images WHERE file_name = 'b.png'").pluck().get()).toBe(1);
  });

  it('全部处理：同一个 batch 的多组在窗口里只算一次，挤出去时整批作废', async () => {
    const db = ds.ctx.db;
    // 手动造 3 个重复组（各自和 i.png 一组），用同一个 batch 处理，保留 i.png
    const T = '2026-01-01T00:00:00.000Z';
    const groups = ['a.png', 'b.png', 'c.png'].map((n) => {
      const g = Number(db.prepare("INSERT INTO duplicate_groups (kind, similarity, created_at) VALUES ('exact', 1, ?)").run(T).lastInsertRowid);
      db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?), (?, ?)').run(g, Number(idOf(n)), g, Number(idOf('i.png')));
      return String(g);
    });
    ds.ctx.invalidate('all');
    const tokens: string[] = [];
    for (const g of groups) {
      const r = await ds.resolveDuplicate(g, [idOf('i.png')], 'batch-1');
      expect(r.expiredUndoTokens).toBeUndefined();
      tokens.push(r.undoToken!);
    }
    // 这一批算 1 次，再来 4 次单独的还都能撤销
    for (const n of ['d.png', 'e.png', 'f.png', 'g.png']) expect((await trash(n)).expiredUndoTokens).toBeUndefined();
    expect(Object.values(await ds.undoStatus(tokens))).toEqual(['live', 'live', 'live']);
    // 第 5 次单独的：整批挤出去
    const r = await trash('h.png');
    expect(r.expiredUndoTokens?.sort()).toEqual([...tokens].sort());
    await ds.pendingTrash.idle();
    expect(moved.sort()).toEqual(['a.png', 'b.png', 'c.png']);
  });
});
