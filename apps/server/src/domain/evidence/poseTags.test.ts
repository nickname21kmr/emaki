/**
 * 姿势标签的低分（迁移 049）：解码时只给名单里、[0.17, 阈值) 的；识别写入只存名单里、范围里的，普通标签不变；
 * 「补充姿势标签」任务（假的识别客户端）：按模型分轮、模型不在本机的跳过、取消后接着补；导入原型的 npz（小夹具）。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { PoseStatus, PoseTagsImportResult } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../core/jobs.ts';
import { EventBus } from '../../core/events.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { patchSettingsInternal } from '../../datasource/sqlite/settings.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { createPoseTagsRunner } from '../../services/pose/tagsJob.ts';
import type { TaggerLike, TaggerStartOptions } from '../../services/tagger/client.ts';
import type { Labels } from '../../services/tagger/labels.ts';
import { decodeRow } from '../../services/tagger/postprocess.ts';
import type { HostItemResult, HostThresholds } from '../../services/tagger/protocol.ts';
import { resetIoBackoff } from '../../services/tagger/readBackoff.ts';
import { createTagJobRunner } from '../../services/tagger/tagJob.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { CharacterCatalog } from '../catalog/characterCatalog.ts';
import { POSE_TAGS, poseTagsLowOf } from './poseTags.ts';
import { TagResultWriter } from './tagger.ts';

const WD = 'SmilingWolf/wd-eva02-large-tagger-v3';
const PIXAI = 'A1yCE/pixai-tagger-v1.0-onnx-fp16';
const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const FIX = path.resolve(import.meta.dirname, '../../../test/fixtures/pose');

let db: Db;
const rows = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a);
function freshDb(n = 3) {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO library_roots (id, path) VALUES (1, 'D:/lib')").run();
  const ins = db.prepare(
    "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 10, 10, 1, 'png', ?, 'x', 'x')",
  );
  for (let i = 1; i <= n; i++) ins.run(i, `${i}.png`, `${i}.png`, `s${i}`);
}

describe('迁移 049', () => {
  it('两张表；删图时低分标签和收集记录跟着删', () => {
    freshDb(1);
    db.exec("INSERT INTO tags (id, name, category) VALUES (7, 'sitting', 'general')");
    db.exec('INSERT INTO image_pose_tags_low (image_id, tag_id, score) VALUES (1, 7, 0.2)');
    db.exec("INSERT INTO image_pose_tags_checked (image_id, model, checked_at) VALUES (1, 'm', 't')");
    expect(() => db.exec('INSERT INTO image_pose_tags_low (image_id, tag_id, score) VALUES (5, 7, 0.2)')).toThrow();
    db.exec('DELETE FROM images WHERE id = 1');
    expect(db.prepare('SELECT (SELECT COUNT(*) FROM image_pose_tags_low) + (SELECT COUNT(*) FROM image_pose_tags_checked)').pluck().get()).toBe(0);
  });
});

describe('解码：姿势标签的低分', () => {
  const L: Labels = {
    names: ['sitting', 'standing', 'v', '1girl'],
    categories: Uint8Array.from([0, 0, 0, 0]),
    ratingIdx: [],
    generalIdx: [0, 1, 2, 3],
    characterIdx: [],
    artistIdx: [],
  };
  const p = Float32Array.from([0.2, 0.5, 0.1, 0.25]);
  it('只看给的下标，范围 [min, 一般标签阈值)；没要求就没有 low', () => {
    const d = decodeRow(p, 0, L, { generalThreshold: 0.35, characterThreshold: 0.35, low: { idx: [0, 1, 2], min: 0.17 } });
    expect(d.general).toEqual([['standing', 0.5]]);
    expect(d.low).toEqual([['sitting', 0.2]]); // 1girl 不在名单，standing 达到阈值，v 低于下限
    expect(decodeRow(p, 0, L, { generalThreshold: 0.35, characterThreshold: 0.35 }).low).toBeUndefined();
    // 补充任务：一般标签门槛 2（不要普通标签），上限另给
    const b = decodeRow(p, 0, L, { generalThreshold: 2, characterThreshold: 2, low: { idx: [0, 1, 2], min: 0.17, max: 0.35 } });
    expect([b.general, b.low]).toEqual([[], [['sitting', 0.2]]]);
  });
});

describe('识别写入：低分姿势标签', () => {
  beforeEach(() => freshDb(3));
  const writer = (poseLow: boolean) => {
    const copyrights = new CopyrightResolver(db, {});
    return new TagResultWriter(db, new CharacterCatalog(db, { copyrights }), copyrights, { repo: WD, generalThreshold: 0.35, poseLow });
  };
  const ok = (id: number, low?: [string, number][]): HostItemResult => ({
    id,
    ok: true,
    rating: null,
    general: [
      ['1girl', 0.99],
      ['sitting', 0.6],
    ],
    character: [],
    ...(low ? { low } : {}),
  });

  it('只存名单里、[0.17, 阈值) 的；普通标签和不要低分时一样；解不开的只记收集过', () => {
    writer(true).writeBatch([
      ok(1, [
        ['looking_back', 0.3],
        ['not_a_pose_tag', 0.3], // 不在名单
        ['standing', 0.35], // 达到阈值（应该在普通标签里）
        ['v', 0.169], // 低于下限
        ['arms_up', 0.17],
      ]),
      ok(2, []),
      { id: 3, ok: false, code: 'DECODE', message: 'x' },
    ]);
    expect(poseTagsLowOf(db, 1)).toEqual([
      ['looking_back', 0.3],
      ['arms_up', 0.17],
    ]);
    expect(poseTagsLowOf(db, 2)).toEqual([]);
    expect(rows('SELECT image_id, model FROM image_pose_tags_checked ORDER BY image_id')).toEqual([1, 2, 3].map((id) => ({ image_id: id, model: WD })));
    const normal = rows('SELECT image_id, t.name, score FROM image_tags JOIN tags t ON t.id = tag_id ORDER BY image_id, t.name');
    // 不要低分：普通标签完全一样，两张表不动
    freshDb(3);
    writer(false).writeBatch([ok(1, [['looking_back', 0.3]]), ok(2, []), { id: 3, ok: false, code: 'DECODE', message: 'x' }]);
    expect(rows('SELECT image_id, t.name, score FROM image_tags JOIN tags t ON t.id = tag_id ORDER BY image_id, t.name')).toEqual(normal);
    expect(rows('SELECT * FROM image_pose_tags_low')).toEqual([]);
    expect(rows('SELECT * FROM image_pose_tags_checked')).toEqual([]);
  });

  it('重识别整体替换这张图的低分标签', () => {
    writer(true).writeBatch([ok(1, [['looking_back', 0.3]])]);
    writer(true).writeBatch([ok(1, [['sitting', 0.2]])]);
    expect(poseTagsLowOf(db, 1)).toEqual([['sitting', 0.2]]);
  });

  it('识别任务向引擎要姿势名单的低分，写进表里', async () => {
    resetIoBackoff();
    let th: HostThresholds | null = null;
    const client: TaggerLike = {
      device: 'cpu',
      batchSize: 2,
      info: { type: 'ready', device: 'cpu', dmlDeviceId: null, fallbackReason: null, batchSize: 2, fixedBatch: false, inputName: 'i', inputShape: [], outputName: 'o', numLabels: 0, loadMs: 0, pid: 1 },
      tag: async (items, t) => {
        th = t;
        return items.map((i) => ok(i.id, [['kneeling', 0.21]]));
      },
    };
    const run = createTagJobRunner({
      db,
      bus: new EventBus(),
      modelsDir: 'X:/models',
      getTaggerSettings: () => ({
        model: WD, device: 'cpu', batchSize: 2, generalThreshold: 0.35, characterThreshold: 0.35, autoAcceptThreshold: 0.85,
        legacyModel: null, legacyBefore: null, skipCameraPhotos: true, retryOld: false, keepAwake: true, artists: false, pixiv: false,
        pixivFilenameMode: 'strict' as const, comicInUnrecognized: true,
      }),
      clientFactory: async () => client,
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
    });
    await run({ signal: new AbortController().signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false } as never);
    expect(th!.low).toEqual({ tags: POSE_TAGS, min: 0.17 });
    expect([1, 2, 3].map((id) => poseTagsLowOf(db, id))).toEqual([1, 2, 3].map(() => [['kneeling', 0.21]]));
  });
});

describe('补充姿势标签、导入原型的低分', () => {
  let dir: string;
  let ds: SqliteDataSource;
  beforeEach(async () => {
    resetIoBackoff();
    dir = makeTmpDir('pose-tags');
    ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), { memory: true, autoJobs: false, importDict: false, clock: () => NOW });
    db = ds.ctx.db;
    db.prepare('INSERT INTO library_roots (id, path) VALUES (1, ?)').run(dir.replace(/\\/g, '/'));
  });
  afterEach(async () => {
    for (const j of await ds.listJobs()) if (j.status === 'queued' || j.status === 'running') await ds.cancelJob(j.id);
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** 识别过的插画；model = null 是没记模型的旧图（按设置里的模型算） */
  function addImage(id: number, model: string | null, kind = 'illustration') {
    db.prepare(
      `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, content_kind, content_kind_source, tagged_at, tagger_model)
       VALUES (@id, 1, @rel, @rel, 100, 100, 10, 'png', @sha, 'x', 'x', @kind, 'default', 'x', @model)`,
    ).run({ id, rel: `${id}.png`, sha: `s${id}`, kind, model });
  }
  const ctxOf = (over: Partial<JobContext> = {}): JobContext & { advance: ReturnType<typeof vi.fn> } =>
    ({ signal: new AbortController().signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false, ...over }) as never;

  it('按模型分轮、只要低分、模型不在本机的跳过；取消后接着补，补完再跑没有要补的', async () => {
    for (let id = 1; id <= 6; id++) addImage(id, id <= 4 ? WD : null); // 5、6 没记模型 → 设置里的 PixAI
    addImage(7, 'some/unknown-model');
    addImage(8, WD, 'photo'); // 照片不补
    const calls: { repo: string; ids: number[]; th: HostThresholds }[] = [];
    const factory = vi.fn(async (o: TaggerStartOptions): Promise<TaggerLike> => ({
      device: 'cpu',
      batchSize: 1,
      info: { type: 'ready', device: 'cpu', dmlDeviceId: null, fallbackReason: null, batchSize: 1, fixedBatch: false, inputName: 'i', inputShape: [], outputName: 'o', numLabels: 0, loadMs: 0, pid: 1 },
      tag: async (items, th) => {
        calls.push({ repo: o.repo, ids: items.map((i) => i.id), th });
        return items.map((i): HostItemResult => ({ id: i.id, ok: true, rating: null, general: [], character: [], low: i.id % 2 ? [['sitting', 0.2]] : [] }));
      },
    }));
    const run = createPoseTagsRunner({
      ctx: ds.ctx,
      modelsDir: 'X:/models',
      clientFactory: factory,
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
      isModelReady: () => true,
    });
    // 第一批写完就取消
    const ac = new AbortController();
    const c1 = ctxOf({ signal: ac.signal });
    c1.advance.mockImplementation(() => ac.abort());
    expect(await run(c1)).toContain('已取消');
    const checked = () => db.prepare('SELECT COUNT(*) FROM image_pose_tags_checked').pluck().get() as number;
    expect(checked()).toBe(4); // 一批 = batchSize × 4 张
    // 接着补：只跑剩下的
    calls.length = 0;
    const msg = await run(ctxOf());
    expect(msg).toContain('补了 2 张');
    expect(calls.flatMap((c) => c.ids).sort()).toEqual([5, 6]);
    expect(calls.every((c) => c.repo === PIXAI && c.th.general === 2 && c.th.low?.max === 0.35 && c.th.low.tags === POSE_TAGS)).toBe(true);
    expect(db.prepare('SELECT image_id, model FROM image_pose_tags_checked WHERE image_id >= 5 ORDER BY image_id').all()).toEqual([
      { image_id: 5, model: PIXAI },
      { image_id: 6, model: PIXAI },
    ]);
    expect(poseTagsLowOf(db, 5)).toEqual([['sitting', 0.2]]);
    expect(poseTagsLowOf(db, 6)).toEqual([]);
    // 不认识的模型补不了；普通标签一条也没写
    expect(await run(ctxOf())).toMatch(/没有要补的图；模型不在本机、跳过 1 张/);
    expect(db.prepare('SELECT COUNT(*) FROM image_tags').pluck().get()).toBe(0);
    // 换了识别模型（重识别成 PixAI）的图要重新补
    db.prepare('UPDATE images SET tagger_model = ? WHERE id = 1').run(PIXAI);
    calls.length = 0;
    await run(ctxOf());
    expect(calls.flatMap((c) => c.ids)).toEqual([1]);
  });

  it('让出：写完手上的这批就停，下次接着补', async () => {
    for (let id = 1; id <= 6; id++) addImage(id, WD);
    let y = false;
    const c = ctxOf({ shouldYield: () => y });
    c.advance.mockImplementation(() => (y = true));
    const run = createPoseTagsRunner({
      ctx: ds.ctx,
      modelsDir: 'X:/models',
      clientFactory: async () => ({
        device: 'cpu',
        batchSize: 1,
        info: { type: 'ready', device: 'cpu', dmlDeviceId: null, fallbackReason: null, batchSize: 1, fixedBatch: false, inputName: 'i', inputShape: [], outputName: 'o', numLabels: 0, loadMs: 0, pid: 1 },
        tag: async (items) => items.map((i): HostItemResult => ({ id: i.id, ok: true, rating: null, general: [], character: [], low: [] })),
      }),
      ensureFiles: async () => ({ dir: 'X:', modelPath: 'X:/m.onnx', labelsPath: 'X:/l.csv' }),
      isModelReady: () => true,
    });
    expect(await run(c)).toContain('已让出');
    expect(c.requeue).toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) FROM image_pose_tags_checked').pluck().get()).toBe(4);
  });

  it('命令：关着 403；状态里有要补的张数和估计时间；本机没有模型时不排任务', async () => {
    for (let id = 1; id <= 4; id++) addImage(id, WD);
    await expect(ds.run('pose.backfillTags', {})).rejects.toMatchObject({ statusCode: 403 });
    patchSettingsInternal(db, 'pose', { enabled: true });
    const st = (await ds.ask('pose.status', {})) as PoseStatus;
    // 测试里没有模型文件：4 张都算「模型不在本机」
    expect(st.tags).toMatchObject({ eligible: 4, pending: 4, missingModel: 4, estimateSeconds: 0, requested: false, job: null, lowTags: 0 });
    const r = (await ds.run('pose.backfillTags', {})) as { message: string; count: number };
    expect(r).toMatchObject({ count: 0, message: expect.stringContaining('识别模型不在本机') });
    expect((await ds.listJobs()).some((j) => j.kind === 'pose-tags')).toBe(false);
  });

  it('导入原型的 npz：只导图库里有的、只留范围里的，已经按现在的模型收过的不覆盖；再导一次结果不变', async () => {
    addImage(1, WD);
    addImage(2, WD);
    addImage(3, WD);
    db.prepare("INSERT INTO image_pose_tags_checked (image_id, model, checked_at) VALUES (3, ?, 'earlier')").run(WD);
    const input = { path: path.join(FIX, 'pose_tags_low.npz') };
    await expect(ds.run('pose.importTagsLow', input)).rejects.toMatchObject({ statusCode: 403 });
    patchSettingsInternal(db, 'pose', { enabled: true });
    await expect(ds.run('pose.importTagsLow', { path: path.join(FIX, 'nope.npz') })).rejects.toMatchObject({ statusCode: 400 });
    const r = (await ds.run('pose.importTagsLow', input)) as PoseTagsImportResult;
    expect(r).toMatchObject({ imported: 2, withTags: 1, tags: 2, missing: 1, skipped: 1 });
    // 图 1：sitting 0.2、v 0.17 留下，standing 0.5 达到阈值不要；图 2 一个也没有；图 3 已经收过，不动
    const dump = () => ({
      low: [1, 2, 3].map((id) => poseTagsLowOf(db, id).map(([n, s]) => [n, Math.round(s * 100) / 100])),
      checked: db.prepare('SELECT image_id, model, checked_at FROM image_pose_tags_checked ORDER BY image_id').all(),
    });
    const first = dump();
    expect(first.low).toEqual([
      [
        ['sitting', 0.2],
        ['v', 0.17],
      ],
      [],
      [],
    ]);
    expect(first.checked).toEqual([
      { image_id: 1, model: WD, checked_at: new Date(NOW).toISOString() },
      { image_id: 2, model: WD, checked_at: new Date(NOW).toISOString() },
      { image_id: 3, model: WD, checked_at: 'earlier' },
    ]);
    const again = (await ds.run('pose.importTagsLow', input)) as PoseTagsImportResult;
    expect(again).toMatchObject({ imported: 0, skipped: 3, missing: 1 });
    expect(dump()).toEqual(first);
  });
});
