import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
