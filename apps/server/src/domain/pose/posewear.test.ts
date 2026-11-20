/**
 * PoseWear 姿势库（实验）：迁移 042、导入姿势库（假的小 PoseWear 文件夹）、导入匹配结果、目录 / 线稿 / 每张图的匹配、
 * 按姿势筛选并按名次排。真实引擎（内存库）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageItem, Page, PoseStatus, PoseWearCatalogResponse, PoseWearOfResponse } from '@emaki/shared';
import { EventBus } from '../../core/events.ts';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { patchSettingsInternal } from '../../datasource/sqlite/settings.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const VIEWS = ['front', 'high', 'low', 'side', 'diag'];

/** 假的 PoseWear：三套单人各一两个 + 一个双人（不导） */
function fakePoseWear(dir: string) {
  const poses = [
    { id: 'full_single_P001', no: 'P001', zh: '后仰坐', cat: '坐姿' },
    { id: 'full_single_P002', no: 'P002', zh: '站立', cat: '站姿' },
    { id: 'full_sexy_P001', no: 'P001', zh: 'S形站姿', cat: '站姿' },
    { id: 'upper80v2_P001', no: 'P001', zh: '比心', cat: '可爱' },
    { id: 'pair60_P001', no: 'P001', zh: '双人', cat: '立位' },
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

describe('迁移 042', () => {
  it('三张表；删图时匹配跟着删，删姿势时匹配跟着删', () => {
    const db = openDatabase(':memory:');
    migrate(db, {});
    db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'X:/p')");
    db.exec(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
             VALUES (1, 1, 'a.png', 'a.png', 10, 10, 1, 'png', 's', 't', 't')`);
    db.exec(`INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, version)
             VALUES ('full_single_P001', 'full_single', 'P001', 'n', 'c', 0, '["front"]', 'front', 1)`);
    db.exec("INSERT INTO image_posewear (image_id, pose_id, method, rank, updated_at) VALUES (1, 'full_single_P001', 'tag_only', 0, 't')");
    db.exec("INSERT INTO image_posewear_candidates (image_id, ord, pose_id, accepted) VALUES (1, 0, 'full_single_P001', 1)");
    db.exec("DELETE FROM posewear_poses WHERE id = 'full_single_P001'");
    expect(db.prepare('SELECT COUNT(*) FROM image_posewear').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM image_posewear_candidates').pluck().get()).toBe(0);
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

  function addImage(id: number) {
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source)
         VALUES (@id, 1, @rel, @rel, 1200, 1700, 1000, 'png', @sha, @at, @at, 'illustration', 'default')`,
      )
      .run({ id, rel: `p/${id}.png`, sha: `sha-${id}`, at: new Date(NOW - id).toISOString() });
  }
  const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 });
  const badRequest = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 400 });

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

  it('关着时 403；打开后导入姿势库、匹配结果，按套和分类列出，按名次筛图', async () => {
    for (const id of [11, 12, 13, 14]) addImage(id);
    const matches = path.join(dir, 'assignments.json');
    writeFileSync(
      matches,
      JSON.stringify({
        // 同一个姿势：名次 3 的排在名次 1 的后面
        '11': { pose_id: 'full_single_P001', distance: 0.1, tag_score: 0.6, method: 'tags+skel', rank: 3, view: 'full_single_P001_side', candidates: [cand('full_single_P001', true), cand('full_single_P002', true), cand('full_sexy_P001', false)] },
        '12': { pose_id: 'full_single_P001', distance: 0.2, tag_score: 0.5, method: 'tags+skel', rank: 1, view: 'full_single_P001_front', candidates: [cand('full_single_P001', true)] },
        '13': { pose_id: 'upper80v2_P001', distance: null, tag_score: 0.7, method: 'tag_only', rank: 0, candidates: [] },
        // 姿势库里没有的姿势、图库里没有的图
        '14': { pose_id: 'pair60_P001', method: 'tags+skel', rank: 0 },
        '99': { pose_id: 'full_single_P002', method: 'tags+skel', rank: 0 },
      }),
    );
    await forbidden(ds.run('pose.importPoseWear', { path: folder }));
    await forbidden(ds.ask('pose.posewear', {}));
    await forbidden(ds.ask('images.list', { posewearPose: 'full_single_P001' }));
    await forbidden(ds.ask('pose.posewearOf', { id: '11' }));
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });

    // 先导匹配结果：还没有姿势库
    await badRequest(ds.run('pose.importPoseWearMatches', { assignmentsPath: matches }));
    await badRequest(ds.run('pose.importPoseWear', { path: path.join(dir, 'nope') }));

    const r = (await ds.run('pose.importPoseWear', { path: folder, viewsPath })) as { poses: number; files: number };
    // 双人的不导；每个姿势 5 张小图 + 1 张大图
    expect(r).toMatchObject({ poses: 4, files: 24 });
    const out = path.join(dir, 'data', 'pose', 'posewear');
    const best = ds.ctx.db.prepare('SELECT id, best_view FROM posewear_poses ORDER BY sort').all();
    expect(best).toEqual([
      { id: 'full_single_P001', best_view: 'high' },
      { id: 'full_single_P002', best_view: 'front' },
      { id: 'full_sexy_P001', best_view: 'front' },
      { id: 'upper80v2_P001', best_view: 'front' },
    ]);

    const m = (await ds.run('pose.importPoseWearMatches', { assignmentsPath: matches })) as { imported: number; candidates: number; missing: number; unknownPose: number };
    expect(m).toMatchObject({ imported: 3, candidates: 4, missing: 1, unknownPose: 1 });

    // 目录：默认只给有图的姿势
    const cat = (await ds.ask('pose.posewear', {})) as PoseWearCatalogResponse;
    expect(cat.poses).toBe(4);
    expect(cat.sets.map((s) => [s.id, s.name, s.count])).toEqual([
      ['full_single', '全身', 2],
      ['upper80v2', '上半身', 1],
    ]);
    expect(cat.sets[0]!.categories).toEqual([
      {
        name: '坐姿',
        count: 2,
        poses: [
          {
            id: 'full_single_P001',
            set: 'full_single',
            number: 'P001',
            name: '后仰坐',
            category: '坐姿',
            count: 2,
            thumbUrl: '/api/pose/posewear/t/full_single_P001_high.webp?v=1',
            imageUrl: '/api/pose/posewear/i/full_single_P001_high.webp?v=1',
          },
        ],
      },
    ]);
    const all = (await ds.ask('pose.posewear', { all: '1' })) as PoseWearCatalogResponse;
    expect(all.sets.flatMap((s) => s.categories.flatMap((c) => c.poses))).toHaveLength(4);

    // 线稿
    const f = (await ds.ask('pose.posewearFile', { size: 'i', file: 'full_single_P001_high.webp' })) as { kind: string; filePath: string; contentType: string };
    expect(f).toMatchObject({ kind: 'path', contentType: 'image/webp', filePath: path.join(out, 'i', 'full_single_P001_high.webp') });
    await expect(ds.ask('pose.posewearFile', { size: 'i', file: 'full_single_P001_side.webp' })).rejects.toMatchObject({ statusCode: 404 });
    await badRequest(ds.ask('pose.posewearFile', { size: 't', file: '../emaki.sqlite' }));

    // 按姿势筛：名次小的在前；给了排序就按排序
    const page = (await ds.ask('images.list', { posewearPose: 'full_single_P001' })) as Page<ImageItem>;
    expect(page.items.map((i) => i.id)).toEqual(['12', '11']);
    expect(page.total).toBe(2);
    const byAdded = (await ds.ask('images.list', { posewearPose: 'full_single_P001', sort: 'addedAt', order: 'desc' })) as Page<ImageItem>;
    expect(byAdded.items.map((i) => i.id)).toEqual(['11', '12']);
    await badRequest(ds.ask('images.list', { posewearPose: 'pair60_P001' }));

    // 一张图的匹配：主要的 + 过了阈值的其他候选，匹配视角的小图
    const of = (await ds.ask('pose.posewearOf', { id: '11' })) as PoseWearOfResponse;
    expect(of.primary).toMatchObject({ pose: { id: 'full_single_P001', count: 2 }, rank: 3, method: 'tags+skel', viewThumbUrl: '/api/pose/posewear/t/full_single_P001_side.webp?v=1' });
    expect(of.related.map((x) => x.pose.id)).toEqual(['full_single_P002']);
    expect(((await ds.ask('pose.posewearOf', { id: '13' })) as PoseWearOfResponse).primary?.viewThumbUrl).toBe('/api/pose/posewear/t/upper80v2_P001_front.webp?v=1');
    expect((await ds.ask('pose.posewearOf', { id: '14' })) as PoseWearOfResponse).toEqual({ imageId: '14', primary: null, related: [] });

    // 状态
    const st = (await ds.ask('pose.status', {})) as PoseStatus;
    expect(st.posewear).toMatchObject({ poses: 4, assigned: 3 });

    // 再导一次结果不变；姿势库重导版本加 1，匹配留着
    const dump = () => ds.ctx.db.prepare('SELECT * FROM image_posewear ORDER BY image_id').all().map((x) => ({ ...(x as object), updated_at: 0 }));
    const before = dump();
    await ds.run('pose.importPoseWearMatches', { assignmentsPath: matches });
    expect(dump()).toEqual(before);
    await ds.run('pose.importPoseWear', { path: folder, viewsPath });
    expect(dump()).toEqual(before);
    const cat2 = (await ds.ask('pose.posewear', {})) as PoseWearCatalogResponse;
    expect(cat2.sets[0]!.categories[0]!.poses[0]!.thumbUrl).toContain('?v=2');

    // 文件不在了的图不算
    ds.ctx.db.prepare('UPDATE images SET missing = 1 WHERE id = 12').run();
    expect(((await ds.ask('pose.posewear', {})) as PoseWearCatalogResponse).sets[0]!.count).toBe(1);
  });

  it('根目录的 poses.json 也认（原型 refs 那份）；没有姿势列表 400', async () => {
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    const alt = path.join(dir, 'alt');
    mkdirSync(path.join(alt, 'p', 't'), { recursive: true });
    writeFileSync(path.join(alt, 'poses.json'), JSON.stringify([{ id: 'full_sexy_P002', no: 'P002', zh: 'x', cat: '坐姿', angles: [{ t: 'p/t/full_sexy_P002_side.webp', i: 'p/i/full_sexy_P002_side.webp' }] }]));
    writeFileSync(path.join(alt, 'p', 't', 'full_sexy_P002_side.webp'), 'x');
    // 没有大图：用小图顶上
    expect(await ds.run('pose.importPoseWear', { path: alt })).toMatchObject({ poses: 1, files: 2 });
    expect(ds.ctx.db.prepare('SELECT best_view FROM posewear_poses').pluck().all()).toEqual(['side']);
    await badRequest(ds.run('pose.importPoseWear', { path: path.join(dir, 'data') }));
  });
});
