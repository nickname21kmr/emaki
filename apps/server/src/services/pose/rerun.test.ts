/**
 * 换了找人模型（POSE_VERSION 2）：旧版本的姿势照常用、标成旧的，「提取姿势」不自动重跑；
 * 用户点「用新的找人模型重新提取」才重跑，重提完清掉标记。导入原型数据记成旧版本、不覆盖新版本的。真实引擎（内存库）、假检测器。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { PoseStatus } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { POSE_VERSION, POSE_VERSION_YOLOX, writePoses } from '../../domain/pose/store.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import type { PoseDetectorFactory, PoseItemResult } from './protocol.ts';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');

describe('用新的找人模型重新提取', () => {
  let dir: string;
  let ds: SqliteDataSource;
  const detected: number[] = [];
  const detector: PoseDetectorFactory = async () => ({
    device: 'cpu',
    detect: async (list) =>
      list.map(({ id }): PoseItemResult => {
        detected.push(id);
        return { id, ok: true, w: 100, h: 100, persons: [] };
      }),
    dispose: async () => {},
  });
  const addImage = (id: number) =>
    ds.ctx.db
      .prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source)
         VALUES (@id, 1, @rel, @rel, 1200, 1700, 1000, 'png', @sha, 'x', 'x', 'illustration', 'default')`,
      )
      .run({ id, rel: `p/${id}.png`, sha: `sha-${id}` });
  const versions = () => ds.ctx.db.prepare('SELECT image_id, version FROM image_poses ORDER BY image_id').all();
  const waitJob = () =>
    vi.waitFor(async () => {
      const jobs = (await ds.listJobs()).filter((j) => j.kind === 'pose');
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')).toBe(true);
    });
  const status = async () => (await ds.ask('pose.status', {})) as PoseStatus;

  beforeEach(async () => {
    detected.length = 0;
    dir = makeTmpDir('pose-rerun');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false, clock: () => NOW, poseDetector: detector });
    ds.ctx.db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
  });
  afterEach(async () => {
    for (const j of await ds.listJobs()) if (j.status === 'queued' || j.status === 'running') await ds.cancelJob(j.id);
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('旧版本的不自动重跑；点了才重提，重提完清掉标记', async () => {
    expect(POSE_VERSION).toBe(2);
    for (let id = 1; id <= 4; id++) addImage(id);
    // 1–3 是旧的找人模型（YOLOX）提取的，4 还没提取
    ds.ctx.apply(() =>
      writePoses(
        ds.ctx.db,
        [1, 2, 3].map((imageId) => ({ imageId, status: 'no_person', group: null, person: null, classId: null, nearestId: null, distance: null, mirror: false })),
        't',
        POSE_VERSION_YOLOX,
      ),
    );
    await ds.updateSettings({ pose: { enabled: true } });
    await waitJob();
    expect(detected).toEqual([4]);
    const st = await status();
    expect(st.counts).toMatchObject({ eligible: 4, processed: 4, pending: 0, outdated: 3 });
    expect(st.rerun).toBe(false);
    // 再点「提取姿势」也不碰旧的
    await ds.run('pose.extract', {});
    await waitJob();
    expect(detected).toEqual([4]);

    const r = (await ds.run('pose.reextract', {})) as { count: number; message: string };
    expect(r).toMatchObject({ count: 3, message: expect.stringContaining('3 张') });
    await waitJob();
    expect(detected.slice(1).sort()).toEqual([1, 2, 3]);
    expect(versions()).toEqual([1, 2, 3, 4].map((image_id) => ({ image_id, version: POSE_VERSION })));
    const after = await status();
    expect(after.counts).toMatchObject({ outdated: 0, pending: 0 });
    expect(after.rerun).toBe(false);
    expect(((await ds.run('pose.reextract', {})) as { count: number }).count).toBe(0);
  });

  it('关着 403', async () => {
    await expect(ds.run('pose.reextract', {})).rejects.toMatchObject({ statusCode: 403 });
  });
});
