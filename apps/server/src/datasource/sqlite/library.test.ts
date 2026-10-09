import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

describe('getStats 近 7 天分桶（本地时区）', () => {
  it('今天 0:00 / 23:59 落在下标 6，6 天前落在下标 0，7 天前不计', async () => {
    const today = new Date(2026, 8, 27, 0, 0, 0, 0); // 本地时间
    const now = today.getTime() + 12 * 3_600_000;
    const dataDir = makeTmpDir('stats');
    const ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, clock: () => now, autoJobs: false });
    const db = ds.ctx.db;
    db.prepare("INSERT INTO library_roots (id, path) VALUES (1, 'D:/x')").run();
    const add = (id: number, ms: number) =>
      db
        .prepare(
          `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
           VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, ?, ?)`,
        )
        .run(id, `a${id}.png`, `s${id}`, new Date(ms).toISOString(), new Date(ms).toISOString());
    const DAY = 86_400_000;
    add(1, today.getTime()); // 今天 0:00
    add(2, today.getTime() + DAY - 60_000); // 今天 23:59
    add(3, today.getTime() - 6 * DAY + 1); // 6 天前
    add(4, today.getTime() - DAY + 1); // 昨天
    add(5, today.getTime() - 7 * DAY + 1); // 7 天前
    ds.ctx.invalidate();
    expect((await ds.getStats()).addedLast7Days).toEqual([1, 0, 0, 0, 0, 1, 2]);
    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('getStats 角色数 / 作品数', () => {
  it('只数有插画的角色和作品，和派生缓存口径一致，且不触发派生缓存重建', async () => {
    const dataDir = makeTmpDir('stats-counts');
    const ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0);
      INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');
      INSERT INTO works (id, name, created_at) VALUES (1, 'W1', 'x'), (2, 'W2', 'x'), (3, 'W3', 'x'), (4, 'W4', 'x'), (5, 'W5', 'x'), (6, 'W6', 'x');
      INSERT INTO characters (id, name, source, created_at) VALUES
        (1, 'C1', 'custom', 'x'), (2, 'C2', 'custom', 'x'), (3, 'C3', 'custom', 'x'),
        (4, 'C4', 'custom', 'x'), (5, 'C5', 'custom', 'x'), (6, 'C6', 'custom', 'x');
      INSERT INTO character_works (character_id, work_id) VALUES (1, 1), (3, 4), (4, 5), (6, 6);`);
    const add = (id: number, root: number, kind: string, extra: { excluded?: boolean; trashed?: boolean } = {}) =>
      db
        .prepare(
          `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
             content_kind, excluded_by, trashed_at) VALUES (?, ?, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', ?, ?, ?)`,
        )
        .run(id, root, `${id}.png`, `s${id}`, kind, extra.excluded ? 1 : null, extra.trashed ? 'x' : null);
    const link = (img: number, cid: number) =>
      db.prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'tagger', 'x')").run(img, cid);
    add(1, 1, 'illustration');
    link(1, 1); // C1、W1 算
    add(2, 1, 'illustration', { excluded: true });
    link(2, 2); // 排除的不算
    add(3, 1, 'comic');
    link(3, 3); // 只有漫画：C3、W4 不算
    db.prepare('INSERT INTO image_copyrights (image_id, work_id) VALUES (3, 3)').run(); // W3 只在漫画里
    add(4, 2, 'illustration');
    link(4, 4); // 文件夹停用：C4、W5 不算
    add(5, 1, 'illustration', { trashed: true });
    link(5, 5); // 回收站的不算
    add(6, 1, 'illustration');
    db.prepare('INSERT INTO image_copyrights (image_id, work_id) VALUES (6, 2)').run(); // W2 只经 copyright

    ds.ctx.invalidate();
    const get = vi.spyOn(ds.derived, 'get');
    const s = await ds.getStats();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    expect([s.characterCount, s.workCount]).toEqual([1, 2]);
    const d = ds.derived.get();
    expect(s.characterCount).toBe([...d.characters.values()].filter((c) => c.imageCount > 0).length);
    expect(s.workCount).toBe([...d.works.values()].filter((w) => w.imageCount > 0).length);
    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
