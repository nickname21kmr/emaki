/**
 * PoseWear 姿势库（实验）：迁移 047（旧的主要匹配和候选搬进 image_posewear_members）、姿势目录随包（不用导入）、
 * 线稿导入（假的小 PoseWear 文件夹）和 pose-covers/、骨架接口、导入原型的单人匹配（assignments_multi.json 和旧的 assignments.json）、
 * 双人匹配（按类型合并、去差分）、目录 / 线稿 / 每张图的匹配、按姿势筛选（低置信在后、只看可靠的）。真实引擎（内存库）。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageItem, Page, PoseStatus, PoseWearCatalogResponse, PoseWearLowResponse, PoseWearOfResponse, PoseWearSkeleton } from '@emaki/shared';
import { EventBus } from '../../core/events.ts';
import { openDatabase } from '../../db/connection.ts';
import { loadMigrations, migrate } from '../../db/migrate.ts';
import { patchSettingsInternal } from '../../datasource/sqlite/settings.ts';
import { findCover } from '../../services/pose/covers.ts';
import { ensurePoseWearCatalog } from '../../services/pose/posewearMatch.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { loadPoseWearAsset } from './posewearAsset.ts';

const asset = loadPoseWearAsset();
const meta = (id: string) => asset.byId.get(id)!;

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const VIEWS = ['front', 'high', 'low', 'side', 'diag'];

/** 假的 PoseWear：三套单人各一两个 + 双人（P054 公主抱、P009 / P010 坐在腿上、P023 成人、P001 不收的类型） */
function fakePoseWear(dir: string) {
  const poses = [
    { id: 'full_single_P001', no: 'P001', zh: '后仰坐', cat: '坐姿' },
    { id: 'full_single_P002', no: 'P002', zh: '站立', cat: '站姿' },
    { id: 'full_sexy_P001', no: 'P001', zh: 'S形站姿', cat: '站姿' },
    { id: 'upper80v2_P001', no: 'P001', zh: '比心', cat: '可爱' },
    { id: 'pair60_P001', no: 'P001', zh: '双人', cat: '立位' },
    { id: 'pair60_P054', no: 'P054', zh: '被公主抱·背部后仰', cat: '立位贴身' },
    { id: 'pair60_P009', no: 'P009', zh: '从背后抱坐膝上', cat: '背面坐位' },
    { id: 'pair60_P010', no: 'P010', zh: '侧坐膝上被拥抱', cat: '背面坐位' },
    { id: 'pair60_P023', no: 'P023', zh: '面对面坐在对方腰上', cat: '骑乘位' },
  ].map((p) => ({ ...p, angles: VIEWS.map((v) => ({ t: `p/t/${p.id}_${v}.webp`, i: `p/i/${p.id}_${v}.webp` })) }));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  mkdirSync(path.join(dir, 'p', 't'), { recursive: true });
  mkdirSync(path.join(dir, 'p', 'i'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'poses.0123abcd.json'), JSON.stringify(poses));
  for (const p of poses)
    for (const v of VIEWS) {
      writeFileSync(path.join(dir, 'p', 't', `${p.id}_${v}.webp`), `t:${p.id}_${v}`);
      writeFileSync(path.join(dir, 'p', 'i', `${p.id}_${v}.webp`), `i:${p.id}_${v}`);
    }
  // 原型挑的代表视角
  const views = path.join(dir, 'views.json');
  writeFileSync(views, JSON.stringify({ full_single_P001: { best_view: 'full_single_P001_high' }, full_sexy_P001: { best_view: null } }));
  return views;
}

const cand = (pose_id: string, accepted: boolean, distance = 0.2) => ({ pose_id, accepted, distance, tag_score: 0.5, method: 'tags+skel' });
const mp = (pose_id: string, rank: number, method: string, primary = false, view?: string) => ({
  pose_id,
  set: pose_id.replace(/_P\d+$/, ''),
  rank,
  method,
  primary,
  distance: method === 'tag_only' ? null : 0.2 + rank / 100,
  tag_score: 0.5,
  score: 1 - rank / 100,
  ...(view ? { view } : {}),
});
const pc = (pose: string, method: 'tags+skel' | 'tag_only', x: number, accepted = true) =>
  method === 'tags+skel'
    ? { pose: `pair60_${pose}`, method, accepted, strength: 1, nclause: 2, tag_score: 0.6, distance: x * 0.4, dist_norm: x }
    : { pose: `pair60_${pose}`, method, accepted, strength: 2, nclause: 2, tag_score: x };

describe('迁移 047', () => {
  it('旧的主要匹配和过了阈值的候选搬进 image_posewear_members；双人能存；删图、删姿势时跟着删', () => {
    const db = openDatabase(':memory:');
    const dir = makeTmpDir('migrate-047');
    copyFileSync(path.join(import.meta.dirname, '../../db/schema.sql'), path.join(dir, 'schema.sql'));
    mkdirSync(path.join(dir, 'migrations'));
    for (const m of loadMigrations().slice(1, 46)) writeFileSync(path.join(dir, 'migrations', m.name), m.sql);
    expect(migrate(db, { dir })).toEqual({ from: 0, to: 46 });
    db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'X:/p')");
    for (const id of [1, 2])
      db.exec(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
               VALUES (${id}, 1, '${id}.png', '${id}.png', 10, 10, 1, 'png', 's${id}', 't', 't')`);
    for (const p of ['full_single_P001', 'full_single_P002'])
      db.exec(`INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, version)
               VALUES ('${p}', 'full_single', 'P00${p.at(-1)}', 'n', 'c', 0, '["front"]', 'front', 1)`);
    db.exec("INSERT INTO image_posewear (image_id, pose_id, method, rank, distance, updated_at) VALUES (1, 'full_single_P001', 'lowtag+skel', 4, 0.3, 't')");
    db.exec(`INSERT INTO image_posewear_candidates (image_id, ord, pose_id, accepted, method) VALUES
             (1, 0, 'full_single_P001', 1, 'lowtag+skel'), (1, 1, 'full_single_P002', 1, 'tags+skel'), (1, 2, 'full_single_P002', 0, 'near_miss')`);
    rmSync(dir, { recursive: true, force: true });

    expect(migrate(db, {})).toMatchObject({ from: 46 });
    const rows = db.prepare('SELECT image_id, pose_id, rank, is_primary, method, low, distance FROM image_posewear_members ORDER BY pose_id').all();
    expect(rows).toEqual([
      { image_id: 1, pose_id: 'full_single_P001', rank: 4, is_primary: 1, method: 'lowtag+skel', low: 1, distance: 0.3 },
      { image_id: 1, pose_id: 'full_single_P002', rank: 1_000_001, is_primary: 0, method: 'tags+skel', low: 0, distance: null },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('image_posewear', 'image_posewear_candidates')").all()).toEqual([]);
    db.exec(`INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, adult, version)
             VALUES ('pair_P054', 'pair', 'P054', '公主抱', '双人', 0, '["front"]', 'front', 0, 1)`);
    db.exec("INSERT INTO image_posewear_members (image_id, pose_id, rank, is_primary, method, low, variant_of, updated_at) VALUES (2, 'pair_P054', 0, 1, 'tag_only', 0, NULL, 't')");
    db.exec("DELETE FROM posewear_poses WHERE id = 'full_single_P002'");
    db.exec('DELETE FROM images WHERE id = 2');
    expect(db.prepare('SELECT pose_id FROM image_posewear_members').pluck().all()).toEqual(['full_single_P001']);
    expect(() =>
      db.exec(`INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, version)
               VALUES ('pair60_P001', 'pair60', 'P001', 'n', 'c', 0, '[]', 'front', 1)`),
    ).toThrow();
    db.close();
  });
});

describe('PoseWear 姿势库', () => {
  let dir: string;
  let ds: SqliteDataSource;
  let folder: string;
  let viewsPath: string;

  function addImage(id: number, extra: { col?: number; dhash?: string } = {}) {
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source, dhash)
         VALUES (@id, 1, @rel, @rel, 1200, 1700, 1000, 'png', @sha, @at, @at, 'illustration', 'default', @dhash)`,
      )
      .run({ id, rel: `p/${id}.png`, sha: `sha-${id}`, at: new Date(NOW - id).toISOString(), dhash: extra.dhash ?? null });
  }
  const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 });
  const badRequest = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 400 });
  const ids = async (q: object) => ((await ds.ask('images.list', q)) as Page<ImageItem>).items.map((i) => i.id);
  const catalog = async (all = false) => (await ds.ask('pose.posewear', all ? { all: '1' } : {})) as PoseWearCatalogResponse;

  beforeEach(async () => {
    dir = makeTmpDir('posewear');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false, clock: () => NOW });
    ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
    folder = path.join(dir, 'PoseWear');
    viewsPath = fakePoseWear(folder);
  });
  afterEach(async () => {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('姿势目录随包：关着时 403；打开后同步进库（不用导入），名字、分类、代表视角照资产；没有线稿时 hasCover 是 false，骨架接口给小人用的点', async () => {
    await forbidden(ds.ask('pose.posewear', {}));
    await forbidden(ds.ask('pose.posewearSkeleton', { id: 'full_single_P001' }));
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    ensurePoseWearCatalog(ds.ctx);
    // 再同步一次不写（版本不动）
    ensurePoseWearCatalog(ds.ctx);
    const rows = ds.ctx.db.prepare('SELECT id, set_id, name, category, best_view, adult, version FROM posewear_poses ORDER BY sort').all() as {
      id: string;
      set_id: string;
      name: string;
      category: string;
      best_view: string;
      adult: number;
      version: number;
    }[];
    expect(rows).toHaveLength(asset.poses.length);
    expect(rows.filter((r) => r.set_id === 'pair').map((r) => r.id)).toEqual(asset.pairs.map((p) => p.id));
    const p1 = meta('full_single_P001');
    expect(rows.find((r) => r.id === p1.id)).toEqual({ id: p1.id, set_id: 'full_single', name: p1.name, category: p1.category, best_view: p1.bestView, adult: 0, version: 1 });
    expect(rows.find((r) => r.id === 'pair_P023')).toMatchObject({ name: '面对面跨坐', category: '成人', adult: 1 });

    const all = await catalog(true);
    expect(all.poses).toBe(asset.poses.length);
    expect(all.sets.map((s) => s.id)).toEqual(['full_single', 'full_sexy', 'upper80v2', 'pair']);
    // 还没有匹配：默认只给有图的，一个也没有
    expect((await catalog()).sets).toEqual([]);
    const pose = all.sets[0]!.categories[0]!.poses[0]!;
    expect(pose).toMatchObject({ id: p1.id, hasCover: false, skeletonUrl: `/api/pose/posewear-skeleton/${p1.id}`, thumbUrl: `/api/pose/posewear/t/${p1.id}_${p1.bestView}.webp?v=1` });
    await expect(ds.ask('pose.posewearFile', { size: 't', file: `${p1.id}_${p1.bestView}.webp` })).rejects.toMatchObject({ statusCode: 404 });

    // 骨架：代表视角，23 个点，坐标按长边归一；双人两个人；没有骨架的双人类型 persons 为空
    const sk = (await ds.ask('pose.posewearSkeleton', { id: p1.id })) as PoseWearSkeleton;
    expect(sk).toMatchObject({ poseId: p1.id, view: p1.bestView, minConfidence: 0.3 });
    expect(sk.persons).toHaveLength(1);
    expect(sk.persons[0]!.points).toHaveLength(23);
    expect(sk.persons[0]!.points.every(([x, y, c]) => x >= -0.5 && x <= 1.5 && y >= -0.5 && y <= 1.5 && c >= 0 && c <= 1)).toBe(true);
    expect(Math.max(sk.w, sk.h)).toBe(1);
    const side = (await ds.ask('pose.posewearSkeleton', { id: p1.id, view: 'side' })) as PoseWearSkeleton;
    expect(side.view).toBe('side');
    const pair = (await ds.ask('pose.posewearSkeleton', { id: 'pair_P054' })) as PoseWearSkeleton;
    expect(pair.persons).toHaveLength(2);
    expect(((await ds.ask('pose.posewearSkeleton', { id: 'pair_P057' })) as PoseWearSkeleton).persons).toEqual([]);
    await expect(ds.ask('pose.posewearSkeleton', { id: 'full_single_P999' })).rejects.toMatchObject({ statusCode: 404 });
    await badRequest(ds.ask('pose.posewearSkeleton', { id: '../x' }));

    // 状态：匹配、线稿
    const st = ((await ds.ask('pose.status', {})) as PoseStatus).posewear;
    expect(st.covers).toMatchObject({ found: 0, total: asset.poses.length });
    expect(st.match).toMatchObject({ eligible: 0, matched: 0, pending: 0, job: null });
  });

  it('线稿：从 PoseWear 文件夹导入（小图全部视角、大图代表视角），之后 hasCover、地址版本加 1；没有线稿的文件夹 400；平铺的文件也认', async () => {
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    await badRequest(ds.run('pose.importPoseWear', { path: path.join(dir, 'nope') }));
    mkdirSync(path.join(dir, 'empty'));
    await badRequest(ds.run('pose.importPoseWear', { path: path.join(dir, 'empty') }));
    const r = (await ds.run('pose.importPoseWear', { path: folder, viewsPath })) as { poses: number; pairTypes: number; files: number };
    // 单人 4 个，双人 3 类（公主抱、坐在腿上用代表 P009、成人的面对面跨坐；P010 不是代表，P001 不收）；每个 5 张小图 + 1 张大图
    expect(r).toMatchObject({ poses: 4, pairTypes: 3, files: 42 });
    const all = await catalog(true);
    const p1 = meta('full_single_P001');
    const pose = all.sets[0]!.categories[0]!.poses[0]!;
    expect(pose).toMatchObject({ id: p1.id, hasCover: true, thumbUrl: `/api/pose/posewear/t/${p1.id}_${p1.bestView}.webp?v=2` });
    expect(all.sets.flatMap((s) => s.categories.flatMap((c) => c.poses)).filter((p) => p.hasCover).map((p) => p.id).sort()).toEqual(
      ['full_sexy_P001', 'full_single_P001', 'full_single_P002', 'pair_P009', 'pair_P023', 'pair_P054', 'upper80v2_P001'].sort(),
    );
    const out = path.join(dir, 'data', 'pose', 'posewear');
    const f = (await ds.ask('pose.posewearFile', { size: 'i', file: `${p1.id}_${p1.bestView}.webp` })) as { filePath: string };
    expect(f.filePath).toBe(path.join(out, 'i', `${p1.id}_${p1.bestView}.webp`));
    // 双人用代表 pair60 的线稿，存成 pair_P054
    expect((await ds.ask('pose.posewearFile', { size: 't', file: 'pair_P054_side.webp' })) as { filePath: string }).toMatchObject({
      filePath: path.join(out, 't', 'pair_P054_side.webp'),
    });
    // 大图只有代表视角：别的视角用小图顶上
    expect(((await ds.ask('pose.posewearFile', { size: 'i', file: `${p1.id}_side.webp` })) as { filePath: string }).filePath).toBe(path.join(out, 't', `${p1.id}_side.webp`));
    await expect(ds.ask('pose.posewearFile', { size: 'i', file: 'full_sexy_P002_side.webp' })).rejects.toMatchObject({ statusCode: 404 });
    await badRequest(ds.ask('pose.posewearFile', { size: 't', file: '../emaki.sqlite' }));
    expect(((await ds.ask('pose.status', {})) as PoseStatus).posewear.covers.found).toBe(7);

    // 平铺的文件夹（线稿直接放在里面）
    const flat = path.join(dir, 'flat');
    mkdirSync(flat);
    writeFileSync(path.join(flat, 'full_sexy_P002_side.webp'), 'x');
    expect(await ds.run('pose.importPoseWear', { path: flat })).toMatchObject({ poses: 1, pairTypes: 0, files: 1 });
    expect((await catalog(true)).sets[0]!.categories[0]!.poses[0]!.thumbUrl).toContain('?v=3');
  });

  it('pose-covers/：PoseWear 的文件名原样放进去（平铺或 t、i、p/t、p/i 下），导入的优先；双人按 pair60 的名字找', () => {
    const covers = path.join(dir, 'pose-covers');
    const imported = path.join(dir, 'imported');
    mkdirSync(path.join(covers, 'i'), { recursive: true });
    mkdirSync(path.join(covers, 'p', 't'), { recursive: true });
    mkdirSync(path.join(imported, 't'), { recursive: true });
    writeFileSync(path.join(covers, 'full_single_P017_side.webp'), 'flat');
    writeFileSync(path.join(covers, 'i', 'full_single_P017_front.webp'), 'big');
    writeFileSync(path.join(covers, 'p', 't', 'pair60_P054_front.webp'), 'pair');
    writeFileSync(path.join(imported, 't', 'full_single_P017_side.webp'), 'imported');
    const dirs = { imported, covers };
    expect(findCover(dirs, 't', 'full_single_P017', 'side')).toBe(path.join(imported, 't', 'full_single_P017_side.webp'));
    expect(findCover(dirs, 'i', 'full_single_P017', 'front')).toBe(path.join(covers, 'i', 'full_single_P017_front.webp'));
    // 只有大图时小图也用它
    expect(findCover(dirs, 't', 'full_single_P017', 'front')).toBe(path.join(covers, 'i', 'full_single_P017_front.webp'));
    expect(findCover(dirs, 't', 'pair_P054', 'front')).toBe(path.join(covers, 'p', 't', 'pair60_P054_front.webp'));
    expect(findCover(dirs, 't', 'full_single_P017', 'low')).toBeNull();
  });

  it('导入原型的单人匹配（本机的捷径）：每个姿势下都有，照原型的名次排（低置信的不往后挪），可以只看可靠的；导入后记成匹配过', async () => {
    for (const id of [11, 12, 13, 14, 15]) addImage(id);
    const matches = path.join(dir, 'assignments_multi.json');
    writeFileSync(
      matches,
      JSON.stringify({
        // 11：主要 P001，也像 P002（低置信）；12：主要 P002；13：P001 低置信但加权分高，名次第一；15：P001 普通
        '11': { framing: 'full', poses: [mp('full_single_P001', 3, 'tags+skel', true, 'full_single_P001_side'), mp('full_single_P002', 5, 'lowtag+skel')] },
        '12': { framing: 'full', poses: [mp('full_single_P002', 1, 'tags+skel', true)] },
        '13': { framing: 'full', poses: [mp('full_single_P001', 1, 'lowtag+skel', true)] },
        '15': { framing: 'full', poses: [mp('full_single_P001', 7, 'tag_only', true), mp('upper80v2_P001', 0, 'skel_only')] },
        // 姿势库里没有的姿势、图库里没有的图
        '14': { framing: 'full', poses: [mp('pair60_P001', 0, 'tags+skel', true)] },
        '99': { framing: 'full', poses: [mp('full_single_P002', 0, 'tags+skel', true)] },
      }),
    );
    await forbidden(ds.ask('images.list', { posewearPose: 'full_single_P001' }));
    await forbidden(ds.ask('pose.posewearOf', { id: '11' }));
    await forbidden(ds.ask('pose.posewearLow', { pose: 'full_single_P001' }));
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    await badRequest(ds.run('pose.importPoseWearMatches', {}));
    // 和库里提取过的姿势一起：导入后这些图记成匹配过，自动的「重新匹配姿势」不马上盖掉
    for (const id of [11, 12, 13])
      ds.ctx.db.prepare("INSERT INTO image_poses (image_id, status, grp, version, updated_at) VALUES (?, 'few_points', NULL, 2, 't')").run(id);

    const m = await ds.run('pose.importPoseWearMatches', { assignmentsPath: matches });
    expect(m).toMatchObject({ imported: 4, memberships: 6, low: 2, missing: 1, unknownPose: 1, pairImages: 0 });
    expect(((await ds.ask('pose.status', {})) as PoseStatus).posewear.match).toMatchObject({ eligible: 3, matched: 3, pending: 0 });

    // 每个姿势下都有：P002 有 12（主要）和 11（也像，低置信）；严格按名次，低置信的 13 在最前
    expect(await ids({ posewearPose: 'full_single_P001' })).toEqual(['13', '11', '15']);
    expect(ds.ctx.db.prepare('SELECT score FROM image_posewear_members WHERE image_id = 13').pluck().get()).toBe(0.99);
    expect(await ids({ posewearPose: 'full_single_P002' })).toEqual(['12', '11']);
    expect(await ids({ posewearPose: 'upper80v2_P001' })).toEqual(['15']);
    // 只看可靠的：低置信去掉
    expect(await ids({ posewearPose: 'full_single_P001', posewearReliable: 'true' })).toEqual(['11', '15']);
    expect(((await ds.ask('images.list', { posewearPose: 'full_single_P001', posewearReliable: '1' })) as Page<ImageItem>).total).toBe(2);
    // 给了排序就按排序
    expect(await ids({ posewearPose: 'full_single_P001', sort: 'addedAt', order: 'desc' })).toEqual(['11', '13', '15']);
    await badRequest(ds.ask('images.list', { posewearPose: 'pair60_P001' }));
    expect(((await ds.ask('pose.posewearLow', { pose: 'full_single_P001' })) as PoseWearLowResponse).ids).toEqual(['13']);

    // 目录：张数、低置信张数
    const cat = await catalog();
    expect(cat.poses).toBe(asset.poses.length);
    expect(cat.sets.map((s) => [s.id, s.name, s.count])).toEqual([
      ['full_single', '全身', 5],
      ['upper80v2', '上半身', 1],
    ]);
    expect(cat.sets[0]!.categories[0]!.poses[0]).toMatchObject({ id: 'full_single_P001', count: 3, low: 1, adult: false, hasCover: false });

    // 一张图的匹配：主要的 + 其他全部（低置信标出来），匹配视角的小图
    const of = (await ds.ask('pose.posewearOf', { id: '11' })) as PoseWearOfResponse;
    expect(of.primary).toMatchObject({ pose: { id: 'full_single_P001' }, rank: 3, low: false, view: 'side', viewHasCover: false, viewThumbUrl: '/api/pose/posewear/t/full_single_P001_side.webp?v=1' });
    expect(of.related.map((x) => [x.pose.id, x.low])).toEqual([['full_single_P002', true]]);
    expect((await ds.ask('pose.posewearOf', { id: '14' })) as PoseWearOfResponse).toEqual({ imageId: '14', primary: null, related: [] });

    // 状态
    const st = (await ds.ask('pose.status', {})) as PoseStatus;
    expect(st.posewear).toMatchObject({ poses: 233, assigned: 4, pairs: 6, low: 2, pair: { types: 11, images: 0, shown: 0 } });

    // 再导一次结果不变
    const dump = () => ds.ctx.db.prepare('SELECT * FROM image_posewear_members ORDER BY image_id, pose_id').all().map((x) => ({ ...(x as object), updated_at: 0 }));
    const before = dump();
    await ds.run('pose.importPoseWearMatches', { assignmentsPath: matches });
    expect(dump()).toEqual(before);

    // 文件不在了的图不算
    ds.ctx.db.prepare('UPDATE images SET missing = 1 WHERE id = 15').run();
    expect((await catalog()).sets[0]!.count).toBe(4);
  });

  it('旧的 assignments.json（主要姿势 + 候选）也认：过了阈值的候选也算在那个姿势下，排在最后', async () => {
    for (const id of [11, 12]) addImage(id);
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const v1 = path.join(dir, 'assignments.json');
    writeFileSync(
      v1,
      JSON.stringify({
        '11': { pose_id: 'full_single_P001', distance: 0.1, tag_score: 0.6, method: 'tags+skel', rank: 3, candidates: [cand('full_single_P001', true), cand('full_single_P002', true), cand('full_sexy_P001', false)] },
        '12': { pose_id: 'full_single_P002', distance: 0.2, tag_score: 0.5, method: 'tags+skel', rank: 8, candidates: [cand('full_single_P002', true)] },
      }),
    );
    expect(await ds.run('pose.importPoseWearMatches', { assignmentsPath: v1 })).toMatchObject({ imported: 2, memberships: 3, low: 0 });
    expect(await ids({ posewearPose: 'full_single_P002' })).toEqual(['12', '11']);
    expect(await ids({ posewearPose: 'full_sexy_P001' })).toEqual([]);
    const of = (await ds.ask('pose.posewearOf', { id: '11' })) as PoseWearOfResponse;
    expect([of.primary?.pose.id, of.related.map((x) => x.pose.id)]).toEqual(['full_single_P001', ['full_single_P002']]);
  });

  it('双人：按类型合并、名次（骨架过了的在前），差分只出现一次，成人一类带 adult；单人、双人各换各的', async () => {
    // 21、22 同一本合集；23、24 dHash 只差 1 位；25 在查重的同一组里和 21；26 单独
    ds.ctx.db.exec("INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, created_at, updated_at) VALUES (1, 1, 'c', 'artbook', 'auto', 'auto', 't', 't')");
    for (const id of [21, 22, 23, 24, 25, 26, 27]) addImage(id, id === 23 ? { dhash: '00000000000000ff' } : id === 24 ? { dhash: '00000000000000fe' } : {});
    ds.ctx.db.exec('UPDATE images SET collection_id = 1 WHERE id IN (21, 22)');
    ds.ctx.db.exec("INSERT INTO duplicate_groups (id, kind, similarity, created_at) VALUES (1, 'similar', 0.9, 't')");
    ds.ctx.db.exec('INSERT INTO duplicate_members (group_id, image_id) VALUES (1, 21), (1, 25)');
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const pairs = path.join(dir, 'pairs.json');
    writeFileSync(
      pairs,
      JSON.stringify({
        // 坐在腿上：26 骨架过了（最前）；21 只靠标签 0.9；22 0.8（和 21 同一本）；25 0.7（和 21 查重同组）
        '26': { pose: 'pair60_P010', top3: [pc('P010', 'tags+skel', 0.5)] },
        '21': { pose: 'pair60_P009', top3: [pc('P009', 'tag_only', 0.9), pc('P010', 'tag_only', 0.5)] },
        '22': { pose: 'pair60_P009', top3: [pc('P009', 'tag_only', 0.8)] },
        '25': { pose: 'pair60_P009', top3: [pc('P009', 'tag_only', 0.7)] },
        // 公主抱：23、24 差分（dHash 近）；27 没过阈值；成人：23 也在
        '23': { pose: 'pair60_P054', top3: [pc('P054', 'tag_only', 0.7), pc('P023', 'tag_only', 0.6)] },
        '24': { pose: 'pair60_P054', top3: [pc('P054', 'tag_only', 0.6)] },
        '27': { pose: null, top3: [pc('P054', 'tag_only', 0.9, false), pc('P001', 'tag_only', 0.9)] },
        '99': { pose: 'pair60_P054', top3: [pc('P054', 'tag_only', 0.9)] },
      }),
    );
    // 先有单人的一条：导双人不动它
    const single = path.join(dir, 'single.json');
    writeFileSync(single, JSON.stringify({ '26': { framing: 'full', poses: [mp('full_single_P001', 0, 'tags+skel', true)] } }));
    await ds.run('pose.importPoseWearMatches', { assignmentsPath: single });
    const r = await ds.run('pose.importPoseWearMatches', { pairsPath: pairs });
    expect(r).toMatchObject({ pairImages: 6, pairVariants: 3 });
    expect(await ids({ posewearPose: 'pair_P009' })).toEqual(['26', '21']);
    expect(await ids({ posewearPose: 'pair_P054' })).toEqual(['23']);
    expect(await ids({ posewearPose: 'pair_P023' })).toEqual(['23']);
    expect(await ids({ posewearPose: 'full_single_P001' })).toEqual(['26']);
    const variants = ds.ctx.db.prepare('SELECT image_id, variant_of FROM image_posewear_members WHERE variant_of IS NOT NULL ORDER BY image_id').all();
    expect(variants).toEqual([
      { image_id: 22, variant_of: 21 },
      { image_id: 24, variant_of: 23 },
      { image_id: 25, variant_of: 21 },
    ]);

    // 目录：双人一套，成人的分类单独、带 adult；差分不算张数
    const pair = (await catalog()).sets.find((s) => s.id === 'pair')!;
    expect(pair.name).toBe('双人');
    expect(pair.categories.map((c) => [c.name, c.count, c.poses.map((p) => [p.id, p.name, p.count, p.adult])])).toEqual([
      ['双人', 3, [['pair_P054', '公主抱', 1, false], ['pair_P009', '坐在腿上', 2, false]]],
      ['成人', 1, [['pair_P023', '面对面跨坐', 1, true]]],
    ]);

    // 看图器：有单人时单人是主要的，双人在后；只有双人时主要的是双人
    const of26 = (await ds.ask('pose.posewearOf', { id: '26' })) as PoseWearOfResponse;
    expect([of26.primary?.pose.id, of26.related.map((x) => x.pose.id)]).toEqual(['full_single_P001', ['pair_P009']]);
    const of22 = (await ds.ask('pose.posewearOf', { id: '22' })) as PoseWearOfResponse;
    expect(of22.primary?.pose.id).toBe('pair_P009');
    const of23 = (await ds.ask('pose.posewearOf', { id: '23' })) as PoseWearOfResponse;
    expect([of23.primary?.pose.id, of23.related.map((x) => x.pose.id)]).toEqual(['pair_P054', ['pair_P023']]);

    expect(((await ds.ask('pose.status', {})) as PoseStatus).posewear).toMatchObject({ assigned: 1, pairs: 1, pair: { types: 11, images: 6, shown: 3 } });

    // 再导单人：双人不动
    await ds.run('pose.importPoseWearMatches', { assignmentsPath: single });
    expect(await ids({ posewearPose: 'pair_P009' })).toEqual(['26', '21']);
  });
});
