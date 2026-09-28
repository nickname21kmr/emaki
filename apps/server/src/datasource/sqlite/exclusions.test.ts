import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { dumpCore } from '../../../test/helpers/dump.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';

const T = '2026-01-01T00:00:00.000Z';

describe('排除规则（sqlite）', () => {
  let ds: SqliteDataSource;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir('excl');
    ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, clock: () => Date.parse(T) });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'F:/tmp');
             INSERT INTO tags (id, name, category) VALUES (1, 'comic', 'general');`);
    const add = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
                            VALUES (?, 1, ?, 'x.png', 1, 1, 1, 'png', ?, '${T}', '${T}')`);
    add.run(1, 'a_b/1.png', 's1');
    add.run(2, 'axb/2.png', 's2');
    add.run(3, 'a_b/3.png', 's3');
    db.exec('INSERT INTO image_tags (image_id, tag_id, score) VALUES (3, 1, 0.9)');
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const excludedBy = () =>
    Object.fromEntries((ds.ctx.db.prepare('SELECT id, excluded_by FROM images ORDER BY id').all() as { id: number; excluded_by: number | null }[]).map((r) => [r.id, r.excluded_by]));

  it('路径里的下划线不当通配符：a_b 不会误伤 axb', async () => {
    const res = await ds.createExclusion({ kind: 'folder', target: 'F:/tmp/a_b' });
    expect(res.message).toBe('已排除：文件夹 · F:/tmp/a_b（2 张）');
    const e = excludedBy();
    expect([e[1] !== null, e[2] !== null, e[3] !== null]).toEqual([true, false, true]);
  });

  it('删掉文件夹规则后，被标签规则覆盖的图仍然排除', async () => {
    await ds.createExclusion({ kind: 'folder', target: 'F:/tmp/a_b' });
    await ds.createExclusion({ kind: 'tag', target: 'comic' }); // 3 已被文件夹规则排除，这里 0 张
    const [tagRule, folderRule] = await ds.listExclusions();
    expect(tagRule!.kind).toBe('tag');
    await ds.deleteExclusion(folderRule!.id);
    expect(excludedBy()).toEqual({ 1: null, 2: null, 3: Number(tagRule!.id) });
  });

  it('执行 → 撤销 → 库状态完全一致；重复规则报冲突', async () => {
    const before = dumpCore(ds.ctx.db);
    const res = await ds.createExclusion({ kind: 'image', target: '2' });
    await expect(ds.createExclusion({ kind: 'image', target: '2' })).rejects.toMatchObject({ code: 'conflict' });
    await ds.undo(res.undoToken!);
    expect(dumpCore(ds.ctx.db)).toEqual(before);
  });
});
