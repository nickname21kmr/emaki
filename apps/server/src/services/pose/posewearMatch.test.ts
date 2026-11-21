/**
 * Emaki 自己匹配 PoseWear 姿势：打开功能后「提取姿势」顺便匹配（假检测器，人物用线稿上的骨架），
 * 标签、低分标签换了由「重新匹配姿势」自动补，全部重算结果不变，取消后暂停、点了接着做；以前提取的行（没记人数）当一个人。真实引擎（内存库）。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem, JobKind, Page, PoseStatus } from '@emaki/shared';
import { EventBus } from '../../core/events.ts';
import { patchSettingsInternal } from '../../datasource/sqlite/settings.ts';
import type { DetectedPerson, Pt } from '../../domain/pose/features.ts';
import { loadPoseWearAsset } from '../../domain/pose/posewearAsset.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import type { PoseDetectorFactory, PoseItemResult } from './protocol.ts';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const asset = loadPoseWearAsset();
const SCALE = 1000;

/** 线稿上的一个人 → 检测结果（像素坐标，框是点的外框放大一点） */
function person(flat: readonly number[], ks: readonly number[]): DetectedPerson {
  const kp = Array.from({ length: 23 }, (_, i) => [flat[2 * i]! * SCALE, flat[2 * i + 1]! * SCALE] as Pt);
  const vis = kp.filter((_, i) => ks[i]! > 0.3);
  const xs = vis.map((p) => p[0]);
  const ys = vis.map((p) => p[1]);
  const m = 40;
  return { box: [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m], score: 0.9, fallback: false, kp, ks: [...ks] };
}
const single = (pose: string, view: string) => {
  const v = asset.allViews.find((x) => x.pose === pose && x.view === view)!;
  return { w: v.w * SCALE, h: v.h * SCALE, persons: [person(v.kp, v.ks)] };
};
const twoOf = (pose: string) => {
  const v = asset.pairViews.find((x) => x.pose === pose && x.persons.length >= 2)!;
  return { w: v.w * SCALE, h: v.h * SCALE, persons: v.persons.slice(0, 2).map((q) => person(q.kp, q.ks)) };
};

describe('PoseWear 匹配（Emaki 里自己做）', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const scenes = new Map<number, { w: number; h: number; persons: DetectedPerson[] }>();
  const detector: PoseDetectorFactory = async () => ({
    device: 'cpu',
    detect: async (list) =>
      list.map(({ id }): PoseItemResult => {
        const s = scenes.get(id);
        return s ? { id, ok: true, ...s } : { id, ok: true, w: 100, h: 100, persons: [] };
      }),
    dispose: async () => {},
  });

  function addImage(id: number, tags: Record<string, number>) {
    const db = ds.ctx.db;
    db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source, tagged_at)
       VALUES (@id, 1, @rel, @rel, 1200, 1700, 1000, 'png', @sha, @at, @at, 'illustration', 'default', @at)`,
    ).run({ id, rel: `p/${id}.png`, sha: `sha-${id}`, at: new Date(NOW - id).toISOString() });
    setTags(id, tags);
  }
  function setTags(id: number, tags: Record<string, number>) {
    const db = ds.ctx.db;
    db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(id);
    for (const [name, score] of Object.entries(tags)) {
      db.prepare("INSERT INTO tags (name, category) VALUES (?, 'general') ON CONFLICT(name) DO NOTHING").run(name);
      db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, (SELECT id FROM tags WHERE name = ?), ?)').run(id, name, score);
    }
  }
  const members = (pose: string) =>
    ds.ctx.db.prepare('SELECT image_id, rank, method, low, variant_of FROM image_posewear_members WHERE pose_id = ? ORDER BY rank').all(pose) as {
      image_id: number;
      rank: number;
      method: string;
      low: number;
      variant_of: number | null;
    }[];
  const status = async () => ((await ds.ask('pose.status', {})) as PoseStatus).posewear;
  const done = (kind: JobKind) =>
    vi.waitFor(async () => {
      const jobs = (await ds.listJobs()).filter((j) => j.kind === kind);
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')).toBe(true);
    });

  beforeEach(async () => {
    scenes.clear();
    dir = makeTmpDir('posewear-match');
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

  it('打开功能就够了：提取姿势时顺便匹配单人和双人，不用导入；名次、人数、两人骨架都记下', async () => {
    // 31：叉腰站（标签也对）；32：公主抱的两个人 + 标签；33：没检测到人，只有标签（双人按标签）；34：叉腰站但没有标签
    addImage(31, { '1girl': 0.9, standing: 0.9, hands_on_own_hips: 0.8 });
    addImage(32, { '2girls': 0.9, princess_carry: 0.8 });
    addImage(33, { '2girls': 0.9, princess_carry: 0.7 });
    addImage(34, { '1girl': 0.9 });
    scenes.set(31, single('full_single_P018', 'front'));
    scenes.set(32, twoOf('P054'));
    scenes.set(34, single('full_single_P018', 'front'));

    await ds.updateSettings({ pose: { enabled: true } });
    await done('pose');
    expect(ds.ctx.db.prepare("SELECT COUNT(*) FROM posewear_poses WHERE set_id = 'pair'").pluck().get()).toBe(asset.pairs.length);
    expect(members('full_single_P018')).toEqual([{ image_id: 31, rank: 1, method: 'tags+skel', low: 0, variant_of: null }]);
    // 双人：骨架过了的在前，只靠标签的在后
    expect(members('pair_P054').map((m) => [m.image_id, m.rank, m.method])).toEqual([
      [32, 1, 'tags+skel'],
      [33, 2, 'tag_only'],
    ]);
    const rows = ds.ctx.db.prepare('SELECT image_id, npers, pair IS NOT NULL AS pair FROM image_poses ORDER BY image_id').all();
    expect(rows).toEqual([
      { image_id: 31, npers: 1, pair: 0 },
      { image_id: 32, npers: 2, pair: 1 },
      { image_id: 33, npers: 0, pair: 0 },
      { image_id: 34, npers: 1, pair: 0 },
    ]);
    const st = await status();
    expect(st.match).toMatchObject({ eligible: 4, matched: 4, pending: 0 });
    expect(st).toMatchObject({ assigned: 1, pair: { images: 2 } });
    // 按姿势找图
    const list = (await ds.ask('images.list', { posewearPose: 'pair_P054' })) as Page<ImageItem>;
    expect(list.items.map((i) => i.id)).toEqual(['32', '33']);
  });

  it('标签换了：「重新匹配姿势」自动补那几张；全部重算结果不变；低分标签也算（低置信）', async () => {
    addImage(31, { standing: 0.9, hands_on_own_hips: 0.8 });
    addImage(34, { standing: 0.9 });
    addImage(35, { standing: 0.9 });
    for (const id of [31, 34, 35]) scenes.set(id, single('full_single_P018', 'front'));
    await ds.updateSettings({ pose: { enabled: true } });
    await done('pose');
    expect(members('full_single_P018').map((m) => m.image_id)).toEqual([31]);

    // 34 重新识别后有了叉腰；35 补了低分的叉腰（0.2）
    setTags(34, { standing: 0.9, hands_on_own_hips: 0.6 });
    ds.ctx.db.prepare('UPDATE images SET tagged_at = ? WHERE id = 34').run(new Date(NOW + 1000).toISOString());
    const tag = ds.ctx.db.prepare("SELECT id FROM tags WHERE name = 'hands_on_own_hips'").pluck().get() as number;
    ds.ctx.db.prepare('INSERT INTO image_pose_tags_low (image_id, tag_id, score) VALUES (35, ?, 0.2)').run(tag);
    ds.ctx.db.prepare("INSERT INTO image_pose_tags_checked (image_id, model, checked_at) VALUES (35, 'm', 't1')").run();
    expect((await status()).match.pending).toBe(2);
    expect(ds.pipeline.requestPoseMatch()).toBe(true);
    await done('pose-match');
    expect((await status()).match.pending).toBe(0);
    // 名次按名次分：31（标签 0.8）、34（0.6）、35（低置信 0.2，不另外往后挪，只是分低）
    expect(members('full_single_P018').map((m) => [m.image_id, m.rank, m.method, m.low])).toEqual([
      [31, 1, 'tags+skel', 0],
      [34, 2, 'tags+skel', 0],
      [35, 3, 'lowtag+skel', 1],
    ]);
    const dump = () => ds.ctx.db.prepare('SELECT * FROM image_posewear_members ORDER BY image_id, pose_id').all().map((x) => ({ ...(x as object), updated_at: 0 }));
    const before = dump();
    await ds.run('pose.rematch', { all: true });
    await done('pose-match');
    expect(dump()).toEqual(before);
    expect((await status()).match).toMatchObject({ matched: 3, pending: 0 });
  });

  it('取消「重新匹配姿势」后不再自动排，点了接着做；以前提取的行（没记人数）当一个人，没有两人骨架时双人按标签', async () => {
    addImage(41, { standing: 0.9, hands_on_own_hips: 0.8, '2girls': 0.9, princess_carry: 0.8 });
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: true });
    // 旧版本提取的：只有主要人物，npers、pair 是空的
    const v = single('full_single_P018', 'front');
    const kp = new Float32Array(2 + 23 * 3);
    const m = Math.max(v.w, v.h);
    kp[0] = v.w / m;
    kp[1] = v.h / m;
    v.persons[0]!.kp.forEach(([x, y], i) => {
      kp[2 + i * 3] = x / m;
      kp[3 + i * 3] = y / m;
      kp[4 + i * 3] = v.persons[0]!.ks[i]!;
    });
    ds.ctx.db.prepare("INSERT INTO image_poses (image_id, status, grp, keypoints, version, updated_at) VALUES (41, 'ok', 'full', ?, 1, 't')").run(Buffer.from(kp.buffer));
    expect((await status()).match.pending).toBe(1);
    const job = (await ds.run('pose.rematch', {})) as { id: string };
    await ds.cancelJob(job.id);
    await done('pose-match');
    // 用户取消了：自动的不排
    if ((await status()).match.pending) expect(ds.pipeline.requestPoseMatch()).toBe(false);
    await ds.run('pose.rematch', {});
    await done('pose-match');
    expect(members('full_single_P018').map((x) => x.image_id)).toEqual([41]);
    expect(members('pair_P054').map((x) => [x.image_id, x.method])).toEqual([[41, 'tag_only']]);
    // 关着时 403
    patchSettingsInternal(ds.ctx.db, 'pose', { enabled: false });
    await expect(ds.run('pose.rematch', {})).rejects.toMatchObject({ statusCode: 403 });
  });
});
