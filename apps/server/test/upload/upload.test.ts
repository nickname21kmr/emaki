/**
 * 手机上传（B1，docs/mobile.md 5.4）的整套流程：走局域网入口、用设备凭证（和 App 一样），引擎是真的 SQLite + 真的图库文件夹
 * （演示模式不让动文件）。电脑上的管理（落点、批次、撤销）走注册表（本机入口的权限）。
 */
import type { UploadBatch, UploadBeginResult, UploadTarget } from '@emaki/shared';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rename, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLanApp } from '../../src/access/lan.ts';
import { EventBus } from '../../src/core/events.ts';
import { cleanupStale, STALE_MS } from '../../src/domain/upload/upload.ts';
import { sharp } from '../../src/services/image/sharpConfig.ts';
import { makeDevice, seedCert, sha256Hex } from '../access/harness.ts';
import { SqliteDataSource } from '../helpers/client.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

process.env.EMAKI_LOG_LEVEL = 'silent';
const move = promisify(rename);

let dir: string, lib: string, dataDir: string, trash: string;
let ds: SqliteDataSource, app: FastifyInstance, rootId: string;
let now = Date.parse('2026-11-20T08:00:00Z');
let auth: Record<string, string>;
let deviceId: string;

beforeEach(async () => {
  dir = makeTmpDir('upload');
  lib = path.join(dir, 'library');
  dataDir = path.join(dir, 'data');
  trash = path.join(dir, 'trash');
  for (const d of [lib, dataDir, trash]) mkdirSync(d, { recursive: true });
  const bus = new EventBus();
  ds = await SqliteDataSource.open(bus, dataDir, {
    memory: true,
    autoJobs: false,
    importDict: false,
    clock: () => now,
    trashImpl: async (files) => {
      for (const f of files) await move(f, path.join(trash, path.basename(f)));
    },
  });
  rootId = String(ds.ctx.db.prepare('INSERT INTO library_roots(path) VALUES(?)').run(lib).lastInsertRowid);
  vi.spyOn(ds.pipeline, 'afterImport').mockImplementation(() => {});
  seedCert(dataDir);
  app = await buildLanApp(ds, bus, ds.access, ds.access.tls(), { webDist: path.join(dir, 'no-web') });
  const d = makeDevice(ds, undefined, '小米平板');
  auth = d.auth;
  deviceId = d.device.id;
  cleanupStale(ds.ctx, true);
});
afterEach(async () => {
  await app.close();
  await ds.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const png = (color: string, w = 12, h = 14) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();
const lan = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
    ...(payload === undefined ? (method === 'POST' ? { payload: {} } : {}) : { payload: payload as object }),
  });
const run = <T>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);
const ask = <T>(name: string, input: unknown = {}) => ds.registry.query<T>(name, input);

/** 和 App 一样：先问、begin、分段 PUT、complete */
async function upload(
  bytes: Buffer,
  opts: { fileName?: string; batchId?: string; album?: string; clientKey?: string; modifiedAt?: string; chunk?: number } = {},
) {
  const sha256 = sha256Hex(bytes);
  const begin = await lan('POST', '/api/uploads', {
    batchId: opts.batchId ?? randomUUID(),
    sha256,
    size: bytes.length,
    fileName: opts.fileName ?? 'pic.png',
    ...(opts.modifiedAt ? { modifiedAt: opts.modifiedAt } : {}),
    ...(opts.album ? { album: opts.album } : {}),
    ...(opts.clientKey ? { clientKey: opts.clientKey } : {}),
  });
  expect(begin.statusCode, begin.body).toBe(200);
  const b = begin.json() as UploadBeginResult;
  if (b.status !== 'receiving') return { begin: b, complete: null };
  const step = opts.chunk ?? 64;
  for (let off = b.received; off < bytes.length; off += step) {
    const res = await lan('PUT', `/api/uploads/${b.uploadId}?offset=${off}`, bytes.subarray(off, off + step));
    expect(res.statusCode, res.body).toBe(200);
  }
  const complete = await lan('POST', `/api/uploads/${b.uploadId}/complete`);
  return { begin: b, complete };
}

/** 图库外面的一个文件（电脑上下载的），用「导入图片」放进图库 */
const outside = (name: string, bytes: Buffer) => {
  mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  const f = path.join(dir, 'downloads', name);
  writeFileSync(f, bytes);
  return f;
};

const fileOf = (imageId: string) => {
  const row = ds.ctx.db
    .prepare('SELECT r.path, i.rel_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
    .get(Number(imageId)) as {
    path: string;
    rel_path: string;
  };
  return { rel: row.rel_path, abs: path.join(row.path, row.rel_path) };
};

describe('传一张', () => {
  it('先问没有 → 分段传 → 入库到默认落点（收件箱/手机/<设备名>/手动上传），保留手机上的修改时间，执行者是这台设备', async () => {
    const bytes = await png('#d72');
    const check = await lan('POST', '/api/uploads/check', { files: [{ sha256: sha256Hex(bytes), size: bytes.length }] });
    expect(check.json()).toEqual({ results: [{ sha256: sha256Hex(bytes), imageId: null, deleted: false, dir: null }] });

    const { complete } = await upload(bytes, { fileName: '12345678_p0.png', modifiedAt: '2025-03-04T05:06:07.000Z', chunk: 50 });
    expect(complete!.statusCode, complete!.body).toBe(200);
    const done = complete!.json();
    expect(done).toMatchObject({ ok: true, status: 'imported', imageId: expect.any(String) });
    const f = fileOf(done.imageId);
    expect(f.rel).toBe('收件箱/手机/小米平板/手动上传/12345678_p0.png');
    expect(readFileSync(f.abs)).toEqual(bytes);
    expect(statSync(f.abs).mtime.toISOString()).toBe('2025-03-04T05:06:07.000Z');
    // 文件名里的 Pixiv 来源照样认得；执行者记成设备
    expect(await ds.getImage(done.imageId)).toMatchObject({ source: { site: 'pixiv', postId: '12345678' } });
    const log = ds.ctx.db.prepare("SELECT actor FROM command_log WHERE command = 'upload.complete' ORDER BY id DESC LIMIT 1").pluck().get();
    expect(log).toBe(`device:${deviceId}`);
    // 再问就有了；.part 没留下
    expect(
      (await lan('POST', '/api/uploads/check', { files: [{ sha256: sha256Hex(bytes), size: bytes.length }] })).json().results[0].imageId,
    ).toBe(done.imageId);
    expect(readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
  });

  it('断点续传：传了一段断了，重新 begin 拿到断点接着传；offset 对不上回 409', async () => {
    const bytes = await png('#2a9', 40, 40);
    const batchId = randomUUID();
    const begin = (
      await lan('POST', '/api/uploads', { batchId, sha256: sha256Hex(bytes), size: bytes.length, fileName: 'a.png' })
    ).json() as UploadBeginResult;
    expect(begin).toMatchObject({ received: 0, status: 'receiving' });
    expect((await lan('PUT', `/api/uploads/${begin.uploadId}?offset=0`, bytes.subarray(0, 30))).json()).toEqual({ received: 30 });
    // 断了，手机重开：同一个文件再 begin，拿到同一个 uploadId 和断点
    const again = (
      await lan('POST', '/api/uploads', { batchId, sha256: sha256Hex(bytes), size: bytes.length, fileName: 'a.png' })
    ).json() as UploadBeginResult;
    expect(again).toEqual({ uploadId: begin.uploadId, received: 30, status: 'receiving', imageId: null });
    const wrong = await lan('PUT', `/api/uploads/${begin.uploadId}?offset=0`, bytes.subarray(0, 30));
    expect([wrong.statusCode, wrong.json().code]).toEqual([409, 'conflict']);
    // 没传完就 complete：409
    expect((await lan('POST', `/api/uploads/${begin.uploadId}/complete`)).statusCode).toBe(409);
    expect((await lan('PUT', `/api/uploads/${begin.uploadId}?offset=30`, bytes.subarray(30))).json()).toEqual({ received: bytes.length });
    const done = await lan('POST', `/api/uploads/${begin.uploadId}/complete`);
    expect(done.json()).toMatchObject({ status: 'imported' });
    expect(readFileSync(fileOf(done.json().imageId).abs)).toEqual(bytes);
  });

  it('内容和 sha256 对不上：400，这一条标失败、.part 删掉，再 begin 从头传', async () => {
    const bytes = await png('#123');
    const fake = Buffer.from(bytes);
    fake.writeUInt8(fake.readUInt8(fake.length - 1) ^ 0xff, fake.length - 1);
    const begin = (
      await lan('POST', '/api/uploads', { batchId: randomUUID(), sha256: sha256Hex(bytes), size: bytes.length, fileName: 'x.png' })
    ).json();
    await lan('PUT', `/api/uploads/${begin.uploadId}?offset=0`, fake);
    const res = await lan('POST', `/api/uploads/${begin.uploadId}/complete`);
    expect([res.statusCode, res.json().code]).toEqual([400, 'bad_request']);
    expect(existsSync(path.join(dataDir, 'uploads', `${begin.uploadId}.part`))).toBe(false);
    const again = (
      await lan('POST', '/api/uploads', { batchId: randomUUID(), sha256: sha256Hex(bytes), size: bytes.length, fileName: 'x.png' })
    ).json();
    expect(again.uploadId).not.toBe(begin.uploadId);
    expect(again.received).toBe(0);
  });
});

describe('同一个文件、同名、重复', () => {
  it('这台设备传过的同一个文件：begin 直接 done，不再传', async () => {
    const bytes = await png('#abc');
    const first = await upload(bytes);
    const id = first.complete!.json().imageId;
    const second = await upload(bytes);
    expect(second.begin).toMatchObject({ status: 'imported', imageId: id, received: bytes.length });
    expect(second.complete).toBeNull();
  });

  it('电脑上别处已经有同样内容的图：入库回 existing 和那张的 id，不再存一份', async () => {
    const bytes = await png('#fe0');
    const imported = (await ds.importImages({ rootId, dir: '下载图片', files: [{ path: outside('old.png', bytes) }] })).items[0]!;
    expect(imported.status).toBe('imported');
    const existingId = imported.status === 'imported' ? imported.imageId : '';
    expect(
      (await lan('POST', '/api/uploads/check', { files: [{ sha256: sha256Hex(bytes), size: bytes.length }] })).json().results[0].imageId,
    ).toBe(existingId);
    // App 照常会先问再决定不传；就算传了，入库也不会多一份
    const { complete } = await upload(bytes, { fileName: 'dup.png' });
    expect(complete!.json()).toMatchObject({ status: 'existing', imageId: existingId });
    expect(existsSync(path.join(lib, '收件箱/手机/小米平板/手动上传/dup.png'))).toBe(false);
  });

  it('同名不同内容：保留两份，不覆盖', async () => {
    const a = await upload(await png('#111'), { fileName: 'same.png' });
    const b = await upload(await png('#222'), { fileName: 'same.png' });
    const fa = fileOf(a.complete!.json().imageId);
    const fb = fileOf(b.complete!.json().imageId);
    expect([fa.rel, fb.rel]).toEqual(['收件箱/手机/小米平板/手动上传/same.png', '收件箱/手机/小米平板/手动上传/same (1).png']);
  });

  it('相册同步（clientKey）：同一个相册文件只传一次，电脑上删了也不会再传；内容改了算新文件；相册进同名子文件夹', async () => {
    const v1 = await png('#456');
    const first = await upload(v1, { album: 'Download', clientKey: 'media:42', fileName: 'a.png' });
    expect(fileOf(first.complete!.json().imageId).rel).toBe('收件箱/手机/小米平板/Download/a.png');
    await run('library.trash', { ids: [first.complete!.json().imageId] });
    const again = await upload(v1, { album: 'Download', clientKey: 'media:42', fileName: 'a.png' });
    expect(again.begin.status).toBe('imported');
    expect(again.complete).toBeNull();
    const v2 = await png('#457');
    const edited = await upload(v2, { album: 'Download', clientKey: 'media:42', fileName: 'a.png' });
    expect(edited.complete!.json()).toMatchObject({ status: 'imported' });
  });
});

describe('权限和入口', () => {
  it('没有 upload 权限的设备：check、begin、PUT 都是 403', async () => {
    const { auth: readOnly } = makeDevice(ds, ['read'], '只读');
    const bytes = await png('#999');
    expect((await lan('POST', '/api/uploads/check', { files: [{ sha256: sha256Hex(bytes), size: 1 }] }, readOnly)).statusCode).toBe(403);
    expect(
      (await lan('POST', '/api/uploads', { batchId: randomUUID(), sha256: sha256Hex(bytes), size: 1, fileName: 'a.png' }, readOnly))
        .statusCode,
    ).toBe(403);
    expect((await lan('PUT', '/api/uploads/x?offset=0', Buffer.from('a'), readOnly)).statusCode).toBe(403);
  });

  it('别的设备的上传：PUT、complete 都当作不存在；电脑上的管理命令设备用不了', async () => {
    const bytes = await png('#777');
    const begin = (
      await lan('POST', '/api/uploads', { batchId: randomUUID(), sha256: sha256Hex(bytes), size: bytes.length, fileName: 'a.png' })
    ).json();
    const { auth: other } = makeDevice(ds, undefined, '另一台');
    expect((await lan('PUT', `/api/uploads/${begin.uploadId}?offset=0`, bytes, other)).statusCode).toBe(404);
    expect((await lan('POST', `/api/uploads/${begin.uploadId}/complete`, undefined, other)).statusCode).toBe(404);
    expect((await lan('GET', '/api/uploads/batches')).statusCode).toBe(403);
  });
});

describe('电脑上：落点、批次、撤销', () => {
  it('改「上传到」：之后的进新落点；按漫画导入的、漫画子文件夹不能选；恢复默认', async () => {
    expect(await ask<UploadTarget[]>('upload.targets')).toEqual([
      { deviceId, rootId, rootPath: lib, dir: '收件箱/手机/小米平板', isDefault: true },
    ]);
    const set = await run<{ target: UploadTarget }>('devices.setUpload', { id: deviceId, rootId, dir: '下载图片/平板导入' });
    expect(set.target).toEqual({ deviceId, rootId, rootPath: lib, dir: '下载图片/平板导入', isDefault: false });
    const { complete } = await upload(await png('#135'), { fileName: 'n.png' });
    expect(fileOf(complete!.json().imageId).rel).toBe('下载图片/平板导入/手动上传/n.png');

    ds.ctx.db
      .prepare('INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?)')
      .run(Number(rootId), '漫画', 'general', 'x');
    await expect(run('devices.setUpload', { id: deviceId, rootId, dir: '漫画/本子' })).rejects.toMatchObject({ statusCode: 400 });
    const comicRoot = String(
      ds.ctx.db.prepare("INSERT INTO library_roots(path, content_mode) VALUES(?, 'comic')").run(path.join(dir, 'comics')).lastInsertRowid,
    );
    await expect(run('devices.setUpload', { id: deviceId, rootId: comicRoot, dir: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(run('devices.setUpload', { id: deviceId, rootId, dir: '../外面' })).rejects.toMatchObject({ statusCode: 400 });

    await run('devices.setUpload', { id: deviceId, rootId: null });
    expect((await ask<UploadTarget[]>('upload.targets'))[0]).toMatchObject({ dir: '收件箱/手机/小米平板', isDefault: true });
  });

  it('批次：计数、新入库的图；撤销这一批把新入库的移到回收站，本来就有的不动；撤销又撤销，图回来了', async () => {
    const batchId = randomUUID();
    const kept = await png('#c00');
    const keptId = (await ds.importImages({ rootId, dir: '旧', files: [{ path: outside('kept.png', kept) }] })).items[0]!;
    const a = await upload(await png('#c01'), { batchId, fileName: 'a.png' });
    const b = await upload(await png('#c02'), { batchId, fileName: 'b.png' });
    await upload(kept, { batchId, fileName: 'kept.png' });
    const [batch] = await ask<UploadBatch[]>('upload.batches');
    expect(batch).toMatchObject({
      id: batchId,
      deviceId,
      deviceName: '小米平板',
      album: null,
      imported: 2,
      existing: 1,
      failed: 0,
      receiving: 0,
      undoneAt: null,
    });
    expect(batch!.imageIds).toEqual([a.complete!.json().imageId, b.complete!.json().imageId]);

    const undo = await run<{ undoToken: string | null }>('upload.undoBatch', { id: batchId });
    expect(undo.undoToken).toEqual(expect.any(String));
    // 在 Emaki 的回收站里（最近几次可撤销，之后才进系统回收站）；本来就有的那张不动
    const trashed = (id: string) => ds.ctx.db.prepare('SELECT trashed_at IS NOT NULL FROM images WHERE id = ?').pluck().get(Number(id));
    expect([trashed(a.complete!.json().imageId), trashed(b.complete!.json().imageId)]).toEqual([1, 1]);
    expect(trashed(keptId.status === 'imported' ? keptId.imageId : '')).toBe(0);
    expect(keptId.status).toBe('imported');
    expect((await ask<UploadBatch[]>('upload.batches'))[0]!.undoneAt).toEqual(expect.any(String));

    await run('history.undo', { token: undo.undoToken });
    expect((await ask<UploadBatch[]>('upload.batches'))[0]!.undoneAt).toBeNull();
    expect(trashed(a.complete!.json().imageId)).toBe(0);
  });
});

describe('清理', () => {
  it('没传完、7 天没动静的：标失败、删 .part；不认识的 .part 也删', async () => {
    const bytes = await png('#0a0');
    const begin = (
      await lan('POST', '/api/uploads', { batchId: randomUUID(), sha256: sha256Hex(bytes), size: bytes.length, fileName: 'a.png' })
    ).json();
    await lan('PUT', `/api/uploads/${begin.uploadId}?offset=0`, bytes.subarray(0, 10));
    const stray = path.join(dataDir, 'uploads', 'stray.part');
    writeFileSync(stray, 'x');
    utimesSync(stray, new Date(now), new Date(now));
    now += STALE_MS + 1000;
    cleanupStale(ds.ctx, true);
    expect(readdirSync(path.join(dataDir, 'uploads'))).toEqual([]);
    expect(ds.ctx.db.prepare('SELECT status FROM uploads WHERE id = ?').pluck().get(begin.uploadId)).toBe('failed');
  });
});
