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

  it('resolve：其余移到回收站，组标为已处理；文件先不动，可撤销，退出时才真的移走', async () => {
    const keep = addImage('a.png', 's1', H);
    addImage('a (1).png', 's1', H);
    addImage('a - 副本.png', 's2', flip(H, 1));
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    expect(g!.suggestedKeepId).toBe(String(keep));
    const r = await ds.resolveDuplicate(g!.id, [String(keep)]);
    expect(r.message).toBe('已保留 1 张，2 张移到回收站');
    expect(r.undoToken).toBeTruthy();
    expect(existsSync(path.join(dir, 'a (1).png'))).toBe(true); // 还没真的移
    expect(await ds.listDuplicates({})).toEqual([]);
    const [done] = await ds.listDuplicates({ resolved: true });
    expect(done!.images).toHaveLength(3); // 已处理的保留全部成员
    expect((await ds.getStats()).duplicateGroupCount).toBe(0);

    // 撤销：组回到待处理，待移记录也没了
    await ds.undo(r.undoToken!);
    expect((await ds.listDuplicates({})).map((x) => x.images.length)).toEqual([3]);
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM pending_trash').pluck().get()).toBe(0);

    // 再处理一次，退出时移进回收站
    await ds.resolveDuplicate(g!.id, [String(keep)]);
    await ds.pendingTrash.flushAll();
    expect(existsSync(path.join(dir, 'a.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'a (1).png'))).toBe(false);
    expect(existsSync(path.join(dir, 'a - 副本.png'))).toBe(false);
    expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM pending_trash').pluck().get()).toBe(0);
  });

  it('resolve 撤销：并到保留图上的整理一起还原', async () => {
    const db = ds.ctx.db;
    const a = addImage('a.png', 's1', H);
    const b = addImage('a (1).png', 's1', H);
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (2, '莫宁', 'custom', ?)").run(T);
    db.prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, 2, 'manual', NULL, ?)").run(b, T);
    db.prepare("UPDATE images SET favorite = 1, rating = 'questionable', rating_manual = 1 WHERE id = ?").run(b);
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    const snap = () => [
      db.prepare('SELECT favorite, rating, rating_manual, trashed_at FROM images WHERE id IN (?, ?) ORDER BY id').all(a, b),
      db.prepare('SELECT image_id, character_id FROM image_characters ORDER BY image_id').all(),
    ];
    const before = snap();
    const r = await ds.resolveDuplicate(g!.id, [String(a)]);
    expect((await ds.getImage(String(a)))!.characterIds).toEqual(['2']);
    await ds.undo(r.undoToken!);
    expect(snap()).toEqual(before);
  });

  it('resolve：副本上手动做的整理并到保留的图上（手动角色、收藏、原创、分级、画师、来源），识别器认的不搬', async () => {
    const db = ds.ctx.db;
    const a = addImage('a.png', 's1', H);
    const b = addImage('a (1).png', 's1', H);
    const LATER = '2026-02-01T00:00:00.000Z';
    db.prepare("INSERT INTO characters (id, name, source, created_at) VALUES (1, '漂泊者', 'custom', ?), (2, '莫宁', 'custom', ?), (3, '识别的', 'custom', ?)").run(T, T, T);
    const link = db.prepare('INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, ?, ?, ?)');
    link.run(a, 1, 'manual', null, T);
    link.run(b, 2, 'manual', null, LATER);
    link.run(b, 3, 'tagger', 0.9, T);
    db.prepare("UPDATE images SET favorite = 1, original_at = ?, rating = 'questionable', rating_manual = 1, artist_manual = 1 WHERE id = ?").run(LATER, b);
    db.prepare("INSERT INTO image_artists (image_id, artist, score) VALUES (?, 'kantoku', 1), (?, 'someone', 0.8)").run(b, a);
    db.prepare(
      "UPDATE images SET source_site = 'pixiv', source_post_id = '98785437', source_artist = 'Killy', source_url = 'https://www.pixiv.net/artworks/98785437', source_manual = 1 WHERE id = ?",
    ).run(b);
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    expect(g!.suggestedKeepId).toBe(String(a));
    await ds.resolveDuplicate(g!.id, [String(a)]);
    expect(db.prepare('SELECT source_site, source_post_id, source_artist, source_url, source_manual FROM images WHERE id = ?').get(a)).toEqual({
      source_site: 'pixiv',
      source_post_id: '98785437',
      source_artist: 'Killy',
      source_url: 'https://www.pixiv.net/artworks/98785437',
      source_manual: 1,
    });

    expect(db.prepare('SELECT character_id, origin, added_at FROM image_characters WHERE image_id = ? ORDER BY character_id').all(a)).toEqual([
      { character_id: 1, origin: 'manual', added_at: T },
      { character_id: 2, origin: 'manual', added_at: LATER },
    ]);
    expect(db.prepare('SELECT favorite, original_at, rating, rating_manual, artist_manual FROM images WHERE id = ?').get(a)).toEqual({
      favorite: 1,
      original_at: LATER,
      rating: 'questionable',
      rating_manual: 1,
      artist_manual: 1,
    });
    expect(db.prepare('SELECT artist FROM image_artists WHERE image_id = ?').pluck().all(a)).toEqual(['kantoku']);
    expect((await ds.getImage(String(a)))!.characterIds.sort()).toEqual(['1', '2']);
  });

  it('resolve：副本归为原创时，保留的图也挂到「原创」作品上（原创页里看得到）', async () => {
    const db = ds.ctx.db;
    const a = addImage('a.png', 's1', H);
    const b = addImage('a (1).png', 's1', H);
    await ds.bulkImages({ ids: [String(b)], action: { type: 'original', value: true } });
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    await ds.resolveDuplicate(g!.id, [String(a)]);
    const wid = (await ds.getStats()).originalWorkId!;
    expect(db.prepare('SELECT score FROM image_copyrights WHERE image_id = ? AND work_id = ?').all(a, Number(wid))).toEqual([{ score: null }]);
    expect((await ds.getImage(String(a)))!.original).toBe(true);
    expect((await ds.listImages({ workId: wid })).items.map((x) => x.id)).toEqual([String(a)]);
    expect((await ds.listWorks({})).find((w) => w.id === wid)!.imageCount).toBe(1);
  });

  it('resolve：保留的图自己改过的分级、画师、来源不被副本覆盖', async () => {
    const db = ds.ctx.db;
    const a = addImage('a.png', 's1', H);
    const b = addImage('a (1).png', 's1', H);
    // a 的来源是手动清空的
    db.prepare("UPDATE images SET rating = 'general', rating_manual = 1, artist_manual = 1, source_manual = 1 WHERE id = ?").run(a);
    db.prepare(
      "UPDATE images SET rating = 'explicit', rating_manual = 1, artist_manual = 1, source_site = 'pixiv', source_post_id = '98785437', source_url = 'https://www.pixiv.net/artworks/98785437', source_manual = 1 WHERE id = ?",
    ).run(b);
    db.prepare("INSERT INTO image_artists (image_id, artist, score) VALUES (?, 'kantoku', 1)").run(b);
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    await ds.resolveDuplicate(g!.id, [String(a)]);
    expect(db.prepare('SELECT rating, favorite FROM images WHERE id = ?').get(a)).toEqual({ rating: 'general', favorite: 0 });
    expect(db.prepare('SELECT count(*) FROM image_artists WHERE image_id = ?').pluck().get(a)).toBe(0);
    expect(db.prepare('SELECT source_url, source_manual FROM images WHERE id = ?').get(a)).toEqual({ source_url: null, source_manual: 1 });
  });

  it('resolve：保留的图上自动解析的来源会被副本手动确认的盖掉，有链接的优先于手动清空的', async () => {
    const db = ds.ctx.db;
    const a = addImage('11111111_p0.png', 's1', H);
    const b = addImage('11111111_p0 (1).png', 's1', H);
    const c = addImage('11111111_p0 (2).png', 's1', H);
    const auto = db.prepare("UPDATE images SET source_site = 'pixiv', source_post_id = '11111111', source_url = 'https://www.pixiv.net/artworks/11111111' WHERE id = ?");
    for (const id of [a, b, c]) auto.run(id);
    db.prepare('UPDATE images SET source_site = NULL, source_post_id = NULL, source_url = NULL, source_manual = 1 WHERE id = ?').run(b);
    db.prepare("UPDATE images SET source_site = 'twitter', source_post_id = '1234567890', source_url = 'https://x.com/someone/status/1234567890', source_manual = 1 WHERE id = ?").run(c);
    ds.dedupe.runOnce();
    const [g] = await ds.listDuplicates({});
    expect(g!.suggestedKeepId).toBe(String(a));
    await ds.resolveDuplicate(g!.id, [String(a)]);
    expect(db.prepare('SELECT source_site, source_post_id, source_url, source_manual FROM images WHERE id = ?').get(a)).toEqual({
      source_site: 'twitter',
      source_post_id: '1234567890',
      source_url: 'https://x.com/someone/status/1234567890',
      source_manual: 1,
    });
  });
});
