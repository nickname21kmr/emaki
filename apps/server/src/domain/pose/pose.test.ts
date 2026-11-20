/**
 * 按姿势找图（实验）：迁移、开关和 403、「提取姿势」任务（假检测器，人物来自原型的检测结果）、类别和张数、
 * 按类别筛选并按距离排序、姿势相近的图、导入原型数据（小夹具，再导一次结果不变）。真实引擎（内存库）。
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem, Page, PoseClassesResponse, PoseSimilarResponse, PoseStatus } from '@emaki/shared';
import { EventBus } from '../../core/events.ts';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import type { PoseDetectorFactory, PoseItemResult } from '../../services/pose/protocol.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { classRefs, loadPoseAsset } from './asset.ts';
import { assignImage, type DetectedPerson } from './features.ts';

interface Item {
  id: number;
  w: number;
  h: number;
  persons: DetectedPerson[];
  expect: { class: string };
}
const FIX = path.resolve(import.meta.dirname, '../../../test/fixtures/pose');
const items = JSON.parse(readFileSync(path.join(FIX, 'agreement.json'), 'utf8')) as Item[];
const refs = classRefs(loadPoseAsset());
const NOW = Date.parse('2026-11-20T12:00:00.000Z');

describe('迁移 041', () => {
  it('建两张表；删图时姿势跟着删，删类别时图上的类别置空', () => {
    const db = openDatabase(':memory:');
    migrate(db, {});
    db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'X:/p')");
    db.exec(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
             VALUES (1, 1, 'a.png', 'a.png', 10, 10, 1, 'png', 's', 't', 't')`);
    db.exec("INSERT INTO pose_classes (id, grp, name, description, sort, medoid, cut, figure, version) VALUES ('full_01', 'full', 'n', 'd', 0, x'00', 0.1, x'00', 1)");
    db.exec("INSERT INTO image_poses (image_id, status, class_id, nearest_id, version, updated_at) VALUES (1, 'ok', 'full_01', 'full_01', 1, 't')");
    db.exec("DELETE FROM pose_classes WHERE id = 'full_01'");
    expect(db.prepare('SELECT class_id, nearest_id FROM image_poses').get()).toEqual({ class_id: null, nearest_id: null });
    db.exec('DELETE FROM images WHERE id = 1');
    expect(db.prepare('SELECT COUNT(*) FROM image_poses').pluck().get()).toBe(0);
    expect(() => db.exec("INSERT INTO pose_classes (id, grp, name, description, sort, medoid, cut, figure, version) VALUES ('x_01', 'x', 'n', 'd', 0, x'00', 0.1, x'00', 1)")).toThrow();
    db.close();
  });
});

describe('姿势检索', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const detected: number[] = [];
  const byId = new Map(items.map((it) => [it.id, it]));
  // 假检测器：原型对这张图的检测结果；不认识的图当成没有人
  const detector: PoseDetectorFactory = async () => ({
    device: 'cpu',
    detect: async (list) =>
      list.map(({ id }): PoseItemResult => {
        detected.push(id);
        const it = byId.get(id);
        return it ? { id, ok: true, w: it.w, h: it.h, persons: it.persons } : { id, ok: true, w: 100, h: 100, persons: [] };
      }),
    dispose: async () => {},
  });
  const sample = [...items.filter((it) => it.expect.class !== 'unclassified').slice(0, 8), ...items.filter((it) => it.expect.class === 'unclassified').slice(0, 2)];

  function addImage(id: number, kind = 'illustration') {
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source)
         VALUES (@id, 1, @rel, @rel, 1200, 1700, 1000, 'png', @sha, @at, @at, @kind, 'default')`,
      )
      .run({ id, rel: `p/${id}.png`, sha: `sha-${id}`, at: new Date(NOW - id).toISOString(), kind });
  }
  const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 });
  const waitJob = () =>
    vi.waitFor(async () => {
      const jobs = (await ds.listJobs()).filter((j) => j.kind === 'pose');
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')).toBe(true);
    });

  beforeEach(async () => {
    detected.length = 0;
    dir = makeTmpDir('pose');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), {
      memory: true,
      autoJobs: false,
      importDict: false,
      clock: () => NOW,
      poseDetector: detector,
    });
    ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
  });
  afterEach(async () => {
    for (const j of await ds.listJobs()) if (j.status === 'queued' || j.status === 'running') await ds.cancelJob(j.id);
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认关：查询 403、不跑任务；打开后提取、归类，和 TypeScript 版的归类一致', async () => {
    for (const it of sample) addImage(it.id);
    addImage(5, 'photo'); // 照片不提取
    const st0 = (await ds.ask('pose.status', {})) as PoseStatus;
    expect(st0.enabled).toBe(false);
    expect(st0.counts).toMatchObject({ eligible: sample.length, processed: 0, pending: sample.length });
    await forbidden(ds.ask('pose.classes', {}));
    await forbidden(ds.ask('images.list', { poseClass: 'full_01' }));
    await forbidden(ds.ask('pose.similar', { id: String(sample[0]!.id) }));
    await forbidden(ds.run('pose.extract', {}));
    expect((await ds.listJobs()).some((j) => j.kind === 'pose')).toBe(false);

    await ds.updateSettings({ pose: { enabled: true } });
    await waitJob();
    expect((await ds.listJobs()).find((j) => j.kind === 'pose')!.status).toBe('done');
    expect(detected.sort()).toEqual(sample.map((s) => s.id).sort());

    const rows = ds.ctx.db.prepare('SELECT image_id, status, grp, class_id, distance, mirror, version FROM image_poses').all() as {
      image_id: number;
      class_id: string | null;
      distance: number | null;
    }[];
    expect(rows).toHaveLength(sample.length);
    for (const it of sample) {
      const a = assignImage(it.persons, it.w, it.h, refs);
      const r = rows.find((x) => x.image_id === it.id)!;
      expect(r.class_id).toBe(a.classId);
    }
    const st = (await ds.ask('pose.status', {})) as PoseStatus;
    expect(st.counts).toMatchObject({ eligible: sample.length, processed: sample.length, pending: 0 });
    expect(st.counts.classified).toBe(rows.filter((r) => r.class_id).length);

    // 类别：四组、51 类，张数按口径
    const cls = (await ds.ask('pose.classes', {})) as PoseClassesResponse;
    expect(cls.groups.map((g) => g.id)).toEqual(['full', 'mid', 'waist', 'bust']);
    expect(cls.groups.flatMap((g) => g.classes)).toHaveLength(51);
    expect(cls.groups.reduce((s, g) => s + g.count, 0)).toBe(st.counts.classified);
    const fig = (await ds.ask('pose.figure', { id: 'full_01' })) as { kind: string; contentType: string; body: Buffer };
    expect(fig.contentType).toBe('image/png');
    expect(fig.body.subarray(1, 4).toString()).toBe('PNG');
    expect(cls.groups[0]!.classes[0]!.figureUrl).toBe('/api/pose/classes/full_01/figure.png?v=2');

    // 按类别筛选：默认按距离近的在前
    const target = rows.find((r) => r.class_id)!.class_id!;
    const same = rows.filter((r) => r.class_id === target).sort((a, b) => a.distance! - b.distance!);
    const page = (await ds.ask('images.list', { poseClass: target })) as Page<ImageItem>;
    expect(page.items.map((i) => Number(i.id))).toEqual(same.map((r) => r.image_id));
    expect(page.total).toBe(same.length);

    // 文件不在了的图不算
    const ex = same[0]!.image_id;
    ds.ctx.db.prepare("UPDATE images SET missing = 1 WHERE id = ?").run(ex);
    const cls2 = (await ds.ask('pose.classes', {})) as PoseClassesResponse;
    expect(cls2.groups.reduce((s, g) => s + g.count, 0)).toBe(st.counts.classified - 1);
    ds.ctx.db.prepare('UPDATE images SET missing = 0 WHERE id = ?').run(ex);

    // 姿势相近：同一类里的其他图，按距离排
    const sim = (await ds.ask('pose.similar', { id: String(same[0]!.image_id) })) as PoseSimilarResponse;
    expect(sim.source.classId).toBe(target);
    expect(sim.total).toBe(same.length - 1);
    const ds_ = sim.items.map((i) => i.distance);
    expect([...ds_].sort((a, b) => a - b)).toEqual(ds_);

    // 再点一次：没有要提取的
    await ds.run('pose.extract', {});
    await waitJob();
    expect((await ds.listJobs()).find((j) => j.kind === 'pose')!.message).toContain('没有需要提取的图');

    await ds.updateSettings({ pose: { enabled: false } });
    await forbidden(ds.ask('pose.classes', {}));
  });

  it('导入原型数据：只导图库里有的图，再导一次结果不变', async () => {
    const asg = JSON.parse(readFileSync(path.join(FIX, 'proto_assignments.json'), 'utf8')) as Record<string, { class: string }>;
    const ids = Object.keys(asg).map(Number).filter((id) => id !== 999999);
    for (const id of ids.slice(0, 3)) addImage(id);
    const input = { keypointsPath: path.join(FIX, 'proto_keypoints.npz'), assignmentsPath: path.join(FIX, 'proto_assignments.json') };
    await forbidden(ds.run('pose.importPrototype', input));
    // 打开时会排提取任务：先把它停住，免得它把剩下的图跑掉
    await ds.updateSettings({ pose: { enabled: true } });
    await waitJob();
    ds.ctx.db.exec('DELETE FROM image_poses');
    const r = (await ds.run('pose.importPrototype', input)) as { imported: number; missing: number; skipped: number };
    expect(r).toMatchObject({ imported: 3, missing: 2, skipped: 0 });
    const dump = () => ds.ctx.db.prepare('SELECT image_id, status, grp, class_id, nearest_id, distance, mirror, hex(keypoints) AS k FROM image_poses ORDER BY image_id').all();
    const first = dump() as { image_id: number; class_id: string | null }[];
    for (const row of first) {
      const want = asg[String(row.image_id)]!.class;
      expect(row.class_id).toBe(want === 'unclassified' ? null : want);
    }
    await ds.run('pose.importPrototype', input);
    expect(dump()).toEqual(first);
    const sizes = ds.ctx.db.prepare('SELECT SUM(size) FROM pose_classes').pluck().get();
    expect(sizes).toBe(first.filter((x) => x.class_id).length);
  });
});
