import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { SqliteDataSource } from '../../datasource/sqlite/SqliteDataSource.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SET_FOLDER_MAX } from '../../datasource/sqlite/duplicates.ts';
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
  return {
    id,
    sha256: `sha${id}`,
    dhash: null,
    width: 1000,
    height: 800,
    bytes: 1000,
    file_name: `${id}.png`,
    added_at: '2026-01-01T00:00:00.000Z',
    ...o,
  };
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

  it(`相似簇超过 ${MAX_COMPONENT} 张丢弃（多半是截图串成的链）；完全重复的不丢`, () => {
    const chain = Array.from({ length: MAX_COMPONENT + 1 }, () => row({ dhash: H }));
    const r = buildGroups(chain, 8);
    expect(r.groups).toEqual([]);
    expect(r.droppedLarge).toBe(1);

    const same = Array.from({ length: MAX_COMPONENT + 1 }, () => row({ sha256: 'z', dhash: H }));
    const e = buildGroups(same, 8);
    expect(e.groups.map((g) => [g.kind, g.memberIds.length])).toEqual([['exact', MAX_COMPONENT + 1]]);
    expect(e.droppedLarge).toBe(0);
  });
});

describe('DedupeService + 接口（:memory:）', () => {
  let ds: SqliteDataSource;
  let dir: string;
  let dataDir: string;
  const T = '2026-03-01T00:00:00.000Z';

  const addImage = (name: string, sha: string, dhash: string | null) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
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
    ds = await SqliteDataSource.open(new EventBus(), dataDir, {
      memory: true,
      autoJobs: false,
      importDict: false,
      clock: () => Date.parse(T),
      trashImpl,
    });
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

  it('同一套：同文件夹、同尺寸、代表图两两相近的组挨着排、带同一个 setId；A 像 B、B 像 C 不会把 A、C 连起来', async () => {
    // 每组两张 dHash 相同、sha 不同的图；组间距离 12（阈值 8 连不上，16 以内算同一套）
    const pair = (dirName: string, tag: string, hash: string) => [
      addImage(`${dirName}/${tag}1.png`, `${dirName}${tag}1`, hash),
      addImage(`${dirName}/${tag}2.png`, `${dirName}${tag}2`, hash),
    ];
    pair('cg', 'a', H);
    // 别的文件夹：和 a 也差 12 位（换一批位翻），不算
    let other = BigInt(`0x${H}`);
    for (let b = 0; b < 12; b++) other ^= 1n << BigInt(b * 5 + 3);
    pair('other', 'x', other.toString(16).padStart(16, '0'));
    pair('cg', 'b', flip(H, 12));
    pair('cg', 'c', flip(H, 24)); // 和 b 近、和 a 远
    ds.dedupe.runOnce();
    const list = await ds.listDuplicates({});
    const folderOf = (g: (typeof list)[number]) => g.images[0]!.relPath.split('/')[0];
    const tagged = list.map((g) => [folderOf(g), g.images[0]!.relPath.split('/')[1]![0], g.setId]);
    const sets = new Set(list.filter((g) => g.setId).map((g) => g.setId));
    expect(sets.size).toBe(1);
    const inSet = tagged
      .filter((t) => t[2])
      .map((t) => t[1])
      .sort();
    expect([
      ['a', 'b'],
      ['b', 'c'],
    ]).toContainEqual(inSet);
    expect(tagged.find((t) => t[0] === 'other')![2]).toBeNull();
    // 同一套的挨着
    const idx = list.flatMap((g, k) => (g.setId ? [k] : []));
    expect(idx[1]! - idx[0]!).toBe(1);

    // 文件夹超过 SET_FOLDER_MAX 张时不归套
    const ins = ds.ctx.db.prepare(
      `INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (1, ?, ?, 10, 10, 1, 'png', ?, ?, ?)`,
    );
    for (let k = 0; k < SET_FOLDER_MAX; k++) ins.run(`cg/filler${k}.png`, `filler${k}.png`, `f${k}`, T, T);
    ds.ctx.invalidate('all'); // 直接写库，手动让列表缓存失效（扫描时靠 library-changed 事件）
    expect((await ds.listDuplicates({})).every((g) => g.setId === null)).toBe(true);
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
