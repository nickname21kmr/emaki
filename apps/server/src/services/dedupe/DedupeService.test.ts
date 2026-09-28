import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { SqliteDataSource } from '../../datasource/sqlite/SqliteDataSource.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { buildGroups, MAX_COMPONENT, type DedupeRow } from './DedupeService.ts';

const H = '3c3c3c3c3c3c3c3c'; // 32 位 1，信息量正常
const flip = (hex: string, bits: number) => {
  let v = BigInt(`0x${hex}`);
  for (let b = 0; b < bits; b++) v ^= 1n << BigInt(b * 7);
  return v.toString(16).padStart(16, '0');
};
let seq = 0;
const row = (o: Partial<DedupeRow> = {}): DedupeRow => {
  const id = ++seq;
  return { id, sha256: `sha${id}`, dhash: null, width: 1000, height: 800, bytes: 1000, file_name: `${id}.png`, added_at: '2026-01-01T00:00:00.000Z', ...o };
};

describe('buildGroups', () => {
  it('同 sha → exact；dHash 接近 → similar，similarity 取最大两两距离', () => {
    const a = row({ sha256: 'x', dhash: H });
    const b = row({ sha256: 'x', dhash: H, file_name: 'a - 副本.png' });
    const c = row({ dhash: flip(H, 3) });
    const d = row({ dhash: flip(H, 6) });
    const lone = row({ dhash: 'f0f0aaaa0f0f5555' });
    const exactOnly = [row({ sha256: 'y', dhash: 'aaaaaaaa55555555' }), row({ sha256: 'y', dhash: 'aaaaaaaa55555555' })];
    const r = buildGroups([a, b, c, d, lone, ...exactOnly], 8);
    const exact = r.groups.filter((g) => g.kind === 'exact');
    const similar = r.groups.filter((g) => g.kind === 'similar');
    expect(exact.map((g) => g.memberIds)).toEqual([exactOnly.map((x) => x.id)]);
    expect(similar).toHaveLength(1);
    const s = similar[0]!;
    expect(s.memberIds).toEqual([a.id, b.id, c.id, d.id]);
    expect(s.similarity).toBeCloseTo(1 - 6 / 64);
    expect(s.suggestedKeepId).toBe(a.id);
  });

  it('宽高比差太多不连；低信息量哈希不参与；缺哈希计数', () => {
    const r = buildGroups(
      [
        row({ dhash: H }),
        row({ dhash: H, width: 800, height: 1000 }),
        row({ dhash: '0000000000000000' }),
        row({ dhash: '0000000000000001' }),
        row({ dhash: null }),
      ],
      8,
    );
    expect(r.groups).toEqual([]);
    expect(r.missingHash).toBe(1);
  });

  it(`分量超过 ${MAX_COMPONENT} 张丢弃`, () => {
    const rows = Array.from({ length: MAX_COMPONENT + 1 }, () => row({ sha256: 'z', dhash: H }));
    const r = buildGroups(rows, 8);
    expect(r.groups).toEqual([]);
    expect(r.droppedLarge).toBe(1);
  });
});

describe('DedupeService + 接口（:memory:）', () => {
  let ds: SqliteDataSource;
  let dir: string;
  let dataDir: string;
  const T = '2026-03-01T00:00:00.000Z';

  const addImage = (name: string, sha: string, dhash: string | null) => {
    writeFileSync(path.join(dir, name), name);
    return Number(
      ds.ctx.db
        .prepare(
          `INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, dhash, added_at, modified_at)
           VALUES (1, ?, ?, 1000, 800, 1000, 'png', ?, ?, ?, ?)`,
        )
        .run(name, name, sha, dhash, T, T).lastInsertRowid,
    );
  };
  const unresolved = () => ds.ctx.db.prepare('SELECT COUNT(*) FROM duplicate_groups WHERE resolved_at IS NULL').pluck().get();

  beforeEach(async () => {
    dir = makeTmpDir('dedupe');
    const trashImpl = async (paths: string[]) => paths.forEach((p) => unlinkSync(p)); // 假回收站
    dataDir = makeTmpDir('dedupe-data');
    ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, importDict: false, clock: () => Date.parse(T), trashImpl });
    ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('重跑不重复插入；过时的未处理组被删除', async () => {
    const a = addImage('a.png', 's1', H);
    addImage('a (1).png', 's2', flip(H, 2));
    expect((await ds.getSettings()).dedupe.lastRunAt).toBeNull();
    expect(ds.dedupe.runOnce().reconcile).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect((await ds.getSettings()).dedupe.lastRunAt).toBe(T); // 跑完记下时间（T26）
    expect(ds.dedupe.runOnce().reconcile).toEqual({ inserted: 0, updated: 1, deleted: 0 });
    ds.ctx.db.prepare("UPDATE images SET dhash = 'f0f0aaaa0f0f5555' WHERE id = ?").run(a);
    expect(ds.dedupe.runOnce().reconcile).toEqual({ inserted: 0, updated: 0, deleted: 1 });
    expect(unresolved()).toBe(0);
  });

  it('ignored 组的子集不再上报', async () => {
    addImage('a.png', 's1', H);
    addImage('b.png', 's2', flip(H, 2));
    addImage('c.png', 's3', flip(H, 4));
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    expect(g!.images).toHaveLength(3);
    await ds.ignoreDuplicate(g!.id);
    ds.ctx.db.prepare("UPDATE images SET dhash = 'f0f0aaaa0f0f5555' WHERE file_name = 'c.png'").run();
    expect(ds.dedupe.runOnce().reconcile.inserted).toBe(0);
    expect(await ds.listDuplicates({})).toEqual([]);
  });

  it('resolve：其余移到回收站，组标为已处理，不可撤销', async () => {
    const keep = addImage('a.png', 's1', H);
    addImage('a (1).png', 's1', H);
    addImage('a - 副本.png', 's2', flip(H, 1));
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    expect(g!.suggestedKeepId).toBe(String(keep));
    const r = await ds.resolveDuplicate(g!.id, [String(keep)]);
    expect(r.message).toBe('已保留 1 张，2 张移到回收站（可在系统回收站还原）');
    expect(r.undoToken).toBeNull();
    expect(existsSync(path.join(dir, 'a.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'a (1).png'))).toBe(false);
    expect(await ds.listDuplicates({})).toEqual([]);
    const [done] = await ds.listDuplicates({ resolved: true });
    expect(done!.images).toHaveLength(3); // 已处理的保留全部成员
    expect((await ds.getStats()).duplicateGroupCount).toBe(0);
  });
});
