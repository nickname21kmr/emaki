/**
 * 同步相册（B2，docs/mobile.md 5.5）：盘点（问电脑时回答在不在「上传到」里、删过没有）、建议同步哪些相册、新图跟着老图走、
 * 按相册路径取名、定下来不再变、设备只能看改自己的、同步传上来的图进为相册定下来的文件夹、电脑上删掉的不会被同步回来。
 * 走局域网入口、用设备凭证（和 App 一样）；电脑上的看和改走注册表（本机入口）。
 */
import type { AlbumSyncConfig, AlbumSyncInfo, DeviceAlbum, UploadBeginResult, UploadCheckResult } from '@emaki/shared';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rename, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLanApp } from '../../src/access/lan.ts';
import { EventBus } from '../../src/core/events.ts';
import { albumFolderName, STALE_RUNNING_MS } from '../../src/domain/upload/albums.ts';
import { cleanupStale } from '../../src/domain/upload/upload.ts';
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
  dir = makeTmpDir('albums');
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
  // 和用户的平板一样：传上来的图放到 下载图片/平板导入
  await run('devices.setUpload', { id: deviceId, rootId, dir: '下载图片/平板导入' });
});
afterEach(async () => {
  await app.close();
  await ds.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

let colorSeed = 0;
/** 每次一张内容不同的小图 */
const png = () => {
  colorSeed++;
  const c = `#${(colorSeed * 2654435761).toString(16).padStart(8, '0').slice(-6)}`;
  return sharp({ create: { width: 10 + (colorSeed % 7), height: 12, channels: 3, background: c } })
    .png()
    .toBuffer();
};
const lan = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
    ...(payload === undefined ? (method === 'POST' ? { payload: {} } : {}) : { payload: payload as object }),
  });
const run = <T>(name: string, input: unknown = {}) => ds.registry.execute<T>(name, input);
const ask = <T>(name: string, input: unknown = {}) => ds.registry.query<T>(name, input);

/** 以前从平板拷过来的图：用「导入图片」放进图库的某个文件夹 */
async function copied(relDir: string, n: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  for (let i = 0; i < n; i++) {
    const bytes = await png();
    const f = path.join(dir, 'downloads', `${randomUUID()}.png`);
    writeFileSync(f, bytes);
    const r = (await ds.importImages({ rootId, dir: relDir, files: [{ path: f }] })).items[0]!;
    expect(r.status).toBe('imported');
    out.push(bytes);
  }
  return out;
}

const check = async (files: Buffer[]) =>
  (
    (
      await lan('POST', '/api/uploads/check', { files: files.map((b) => ({ sha256: sha256Hex(b), size: b.length })) })
    ).json() as UploadCheckResult
  ).results;

/** 和 App 的盘点一样：问电脑，按相册数出 有 / 在「上传到」里 / 删过 / 没有，最集中的文件夹 */
async function inventory(files: Buffer[]) {
  const results = await check(files);
  const folders = new Map<string, number>();
  for (const r of results) if (r.dir !== null) folders.set(r.dir, (folders.get(r.dir) ?? 0) + 1);
  const top = [...folders.entries()].sort((a, b) => b[1] - a[1])[0];
  const fresh = results.filter((r) => !r.imageId && !r.deleted);
  return {
    total: files.length,
    have: results.filter((r) => r.imageId).length,
    inTarget: results.filter((r) => r.dir !== null).length,
    deleted: results.filter((r) => r.deleted).length,
    new: fresh.length,
    newBytes: fresh.length * 100,
    folder: top?.[0] ?? null,
    folderCount: top?.[1] ?? 0,
  };
}

const report = async (body: unknown) => {
  const res = await lan('POST', '/api/uploads/albums', body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AlbumSyncConfig;
};
const info = () => ask<AlbumSyncInfo>('upload.albums', { deviceId });
const album = async (p: string) => (await info()).albums.find((a) => a.path === p) as DeviceAlbum;

async function sendSync(bytes: Buffer, opts: { album: string; clientKey: string; fileName: string; batchId?: string }) {
  const begin = await lan('POST', '/api/uploads', {
    batchId: opts.batchId ?? randomUUID(),
    sha256: sha256Hex(bytes),
    size: bytes.length,
    fileName: opts.fileName,
    album: opts.album,
    clientKey: opts.clientKey,
  });
  expect(begin.statusCode, begin.body).toBe(200);
  const b = begin.json() as UploadBeginResult;
  if (b.status !== 'receiving') return { begin: b, complete: null };
  expect((await lan('PUT', `/api/uploads/${b.uploadId}?offset=${b.received}`, bytes.subarray(b.received))).statusCode).toBe(200);
  return { begin: b, complete: await lan('POST', `/api/uploads/${b.uploadId}/complete`) };
}

const relOf = (imageId: string) => ds.ctx.db.prepare('SELECT rel_path FROM images WHERE id = ?').pluck().get(Number(imageId)) as string;

describe('相册路径取名（没有老图时新图放的文件夹）', () => {
  it.each([
    ['Download', 'Download'],
    ['Download/QQBrowser/1700284633722/图片收藏', 'QQBrowser'],
    ['QQBrowser/图片收藏', 'QQBrowser'],
    ['qqbrowser/图片收藏', 'qqbrowser'],
    ['DCIM/tieba', 'tieba'],
    ['DCIM/Screenshots', 'Screenshots'],
    ['Pictures', 'Pictures'],
    ['Pictures/bili', 'bili'],
    ['Pictures/微博动图', '微博动图'],
    ['tencent/QQ_Images', 'tencent/QQ_Images'],
    ['考研/报名', '考研/报名'],
    ['Android/media/com.tencent.mm/WeiXin', 'WeiXin'],
    ['Pictures/.hidden', 'hidden'],
    ['Pictures/a:b', 'a_b'],
  ])('%s → %s', (p, name) => expect(albumFolderName(p)).toBe(name));
});

describe('问电脑有没有（盘点用）', () => {
  it('在「上传到」里的回答所在文件夹；在别处的只给 id；删过的标出来；本机入口上不回答文件夹', async () => {
    const [inPad] = await copied('下载图片/平板导入/下载', 1);
    const [deeper] = await copied('下载图片/平板导入/下载/2024', 1);
    const [atTarget] = await copied('下载图片/平板导入', 1);
    const [elsewhere] = await copied('下载图片/图集', 1);
    const [gone] = await copied('下载图片/平板导入/下载', 1);
    const goneId = (await check([gone!]))[0]!.imageId!;
    await run('library.trash', { ids: [goneId] });
    const fresh = await png();
    const results = await check([inPad!, deeper!, atTarget!, elsewhere!, gone!, fresh]);
    expect(results.map((r) => [r.dir, r.deleted, r.imageId !== null])).toEqual([
      ['下载', false, true],
      ['下载/2024', false, true],
      ['', false, true],
      [null, false, true],
      [null, true, false],
      [null, false, false],
    ]);
    // 电脑上问（没有「哪台设备」）：只回答有没有
    const local = await ask<UploadCheckResult>('upload.check', { files: [{ sha256: sha256Hex(inPad!), size: 1 }] });
    expect(local.results[0]).toMatchObject({ dir: null, deleted: false, imageId: expect.any(String) });
  });
});

describe('盘点 → 建议同步、新图放到哪', () => {
  it('以前拷过的相册建议同步、跟着老图走；老图不在「上传到」里的、拷了一半的、没拷过的不建议；同名相册放一起', async () => {
    // 平板上：Download 5 张，以前拷了 4 张到 平板导入/下载；QQ 浏览器两个相册都拷到 平板导入/QQ浏览器；
    // Pictures 的老图在 图集（不在「上传到」里）；MiShare 4 张里 2 张在平板导入（刚好一半）；截图没拷过
    const download = [...(await copied('下载图片/平板导入/下载', 4)), await png()];
    const qq1 = await copied('下载图片/平板导入/QQ浏览器', 3);
    const qq2 = [...(await copied('下载图片/平板导入/QQ浏览器', 1)), await png()];
    const pictures = [...(await copied('下载图片/图集', 5)), await png()];
    const mishare = [...(await copied('下载图片/平板导入/下载', 2)), ...(await copied('下载图片/手机导入', 2))];
    const shots = [await png(), await png()];
    const albums = [
      ['Download', 'Download', download],
      ['QQBrowser/图片收藏', '图片收藏', qq1],
      ['qqbrowser/图片收藏', '图片收藏', qq2],
      ['Pictures', 'Pictures', pictures],
      ['Download/MiShare', 'MiShare', mishare],
      ['DCIM/Screenshots', 'Screenshots', shots],
    ] as const;
    const config = await report({
      full: true,
      albums: await Promise.all(
        albums.map(async ([p, name, files]) => ({
          path: p,
          name,
          count: files.length,
          bytes: files.length * 100,
          inventory: await inventory(files),
        })),
      ),
      state: { running: null, summary: '盘点完了' },
    });
    expect(config).toMatchObject({ ok: true, wifiOnly: true, chargingOnly: false });
    expect(config.albums.every((a) => !a.sync)).toBe(true);

    const all = await info();
    expect(all.state).toMatchObject({ running: null, summary: '盘点完了', inventoriedAt: expect.any(String) });
    const by = Object.fromEntries(all.albums.map((a) => [a.path, a]));
    expect(by.Download).toMatchObject({
      suggested: true,
      dir: '下载',
      dirReason: 'history',
      dirFixed: false,
      dirNote: '以前的 4 张都在这里',
      inventory: { total: 5, have: 4, inTarget: 4, new: 1, folder: '下载', folderCount: 4 },
    });
    expect(by['QQBrowser/图片收藏']).toMatchObject({ suggested: true, dir: 'QQ浏览器', dirReason: 'history' });
    // 只有 1 张老图（不够 3 张作证）：不建议，文件夹按名字
    expect(by['qqbrowser/图片收藏']).toMatchObject({ suggested: false, dir: 'qqbrowser', dirReason: 'name' });
    expect(by.Pictures).toMatchObject({ suggested: false, dir: 'Pictures', inventory: { have: 5, inTarget: 0 } });
    expect(by['Download/MiShare']).toMatchObject({ suggested: false, inventory: { have: 4, inTarget: 2 } });
    expect(by['DCIM/Screenshots']).toMatchObject({ suggested: false, dir: 'Screenshots', inventory: { have: 0, new: 2 } });

    // 按建议同步 + 第二个 QQ 浏览器相册：同名的跟着第一个定下来的文件夹
    const set = await run<{ message: string; info: AlbumSyncInfo }>('upload.setAlbums', {
      deviceId,
      albums: [
        { path: 'Download', sync: true },
        { path: 'QQBrowser/图片收藏', sync: true },
        { path: 'qqbrowser/图片收藏', sync: true },
      ],
    });
    expect(set.message).toBe('开始同步 3 个相册');
    const after = Object.fromEntries(set.info.albums.map((a) => [a.path, a]));
    expect(after.Download).toMatchObject({ sync: true, dir: '下载', dirFixed: true, dirReason: 'history' });
    expect(after['qqbrowser/图片收藏']).toMatchObject({ sync: true, dir: 'QQ浏览器', dirFixed: true, dirReason: 'name' });
    // App 拿到的同步清单
    const next = await report({ albums: [] });
    expect(next.albums.filter((a) => a.sync).map((a) => a.path)).toEqual(['Download', 'QQBrowser/图片收藏', 'qqbrowser/图片收藏']);
  });

  it('定下来就不再变：再盘点老图挪了也不跟；用户改的、恢复自动', async () => {
    const files = await copied('下载图片/平板导入/下载', 3);
    await report({ albums: [{ path: 'Download/', name: 'Download', count: 3, bytes: 300, inventory: await inventory(files) }] });
    await run('upload.setAlbums', { deviceId, albums: [{ path: 'Download', sync: true }] });
    expect(await album('Download')).toMatchObject({ dir: '下载', dirFixed: true });
    // 老图被挪到了别的文件夹，再盘点：盘点结果变了，定下来的文件夹不变
    await report({
      albums: [
        {
          path: 'Download',
          name: 'Download',
          count: 3,
          bytes: 300,
          inventory: { total: 3, have: 3, inTarget: 3, deleted: 0, new: 0, newBytes: 0, folder: '别处', folderCount: 3 },
        },
      ],
    });
    expect(await album('Download')).toMatchObject({ dir: '下载', dirFixed: true, inventory: { folder: '别处' } });
    await run('upload.setAlbums', { deviceId, albums: [{ path: 'Download', dir: '平板下载\\新' }] });
    expect(await album('Download')).toMatchObject({ dir: '平板下载/新', dirReason: 'manual', dirNote: '你改的' });
    // 恢复自动：同步开着，马上按现在的盘点重新定
    await run('upload.setAlbums', { deviceId, albums: [{ path: 'Download', dir: null }] });
    expect(await album('Download')).toMatchObject({ dir: '别处', dirReason: 'history', dirFixed: true });
    await expect(run('upload.setAlbums', { deviceId, albums: [{ path: 'Download', dir: 'a/../b' }] })).rejects.toThrow();
  });

  it('完整清单里没有的：没同步的删掉，同步着的标成「手机上没有了」；只在 Wi-Fi、充电', async () => {
    await report({
      full: true,
      albums: [
        { path: 'Download', name: 'Download', count: 1, bytes: 1 },
        { path: 'DCIM/Camera', name: 'Camera', count: 1, bytes: 1 },
      ],
    });
    await run('upload.setAlbums', { deviceId, albums: [{ path: 'Download', sync: true }], wifiOnly: false, chargingOnly: true });
    const config = await report({ full: true, albums: [] });
    expect(config).toMatchObject({ wifiOnly: false, chargingOnly: true, albums: [] });
    expect((await info()).albums.map((a) => [a.path, a.gone, a.sync])).toEqual([['Download', true, true]]);
    // 又出现了
    await report({ full: true, albums: [{ path: 'Download', name: 'Download', count: 2, bytes: 2 }] });
    expect(await album('Download')).toMatchObject({ gone: false, count: 2 });
  });

  it('App 报的状态：正在同步和进度；太久没报就不算在跑了；同步完记下还没传的', async () => {
    await report({ albums: [{ path: 'Download', name: 'Download', count: 9, bytes: 9 }], state: { running: 'sync', done: 3, total: 9 } });
    expect((await info()).state).toMatchObject({ running: 'sync', done: 3, total: 9 });
    now += STALE_RUNNING_MS + 1000;
    expect((await info()).state).toMatchObject({ running: null, done: null });
    await report({
      albums: [{ path: 'Download', name: 'Download', count: 9, bytes: 9, pending: 1 }],
      state: { running: null, summary: '同步了 8 张，1 张没传成', error: null },
    });
    expect((await info()).state).toMatchObject({ running: null, summary: '同步了 8 张，1 张没传成', syncedAt: expect.any(String) });
    expect(await album('Download')).toMatchObject({ pending: 1, syncedAt: expect.any(String) });
  });
});

describe('权限', () => {
  it('设备只能看、改自己的；报相册只有设备能调；电脑上要给 deviceId', async () => {
    await report({ albums: [{ path: 'Download', name: 'Download', count: 1, bytes: 1 }] });
    const own = await lan('GET', '/api/uploads/albums');
    expect([own.statusCode, own.json().albums.length]).toEqual([200, 1]);
    const { device: other, auth: otherAuth } = makeDevice(ds, undefined, '另一台');
    expect((await lan('GET', `/api/uploads/albums?deviceId=${deviceId}`, undefined, otherAuth)).statusCode).toBe(404);
    expect((await lan('PATCH', '/api/uploads/albums', { deviceId, wifiOnly: false }, otherAuth)).statusCode).toBe(404);
    expect((await lan('GET', '/api/uploads/albums', undefined, otherAuth)).json()).toMatchObject({ deviceId: other.id, albums: [] });
    // 设备自己改
    const res = await lan('PATCH', '/api/uploads/albums', { albums: [{ path: 'Download', sync: true }] });
    expect([res.statusCode, res.json().info.albums[0].sync]).toEqual([200, true]);
    await expect(run('upload.reportAlbums', { albums: [] })).rejects.toThrow(/只有手机上的 App/);
    await expect(ask('upload.albums', {})).rejects.toThrow(/deviceId/);
    const { auth: readOnly } = makeDevice(ds, ['read'], '只读');
    expect((await lan('GET', '/api/uploads/albums', undefined, readOnly)).statusCode).toBe(403);
  });
});

describe('同步传上来的图', () => {
  it('进为相册定下来的文件夹；电脑上删掉的不会再传；上次传失败的接着用那一行', async () => {
    const old = await copied('下载图片/平板导入/QQ浏览器', 3);
    const p = 'Download/QQBrowser/1700284633722/图片收藏';
    await report({ albums: [{ path: p, name: '图片收藏', count: 4, bytes: 4, inventory: await inventory(old) }] });
    await run('upload.setAlbums', { deviceId, albums: [{ path: p, sync: true }] });
    const fresh = await png();
    const sent = await sendSync(fresh, { album: `${p}/`, clientKey: '1000000121', fileName: '151111643_p0.png' });
    const imageId = sent.complete!.json().imageId as string;
    expect(relOf(imageId)).toBe('下载图片/平板导入/QQ浏览器/151111643_p0.png');
    // 批次里记的是手机上的相册路径
    expect((await ask<{ album: string | null }[]>('upload.batches'))[0]!.album).toBe(p);

    // 电脑上删了：问的时候标成删过（App 不再传）；就算又来 begin，也直接回传过了
    await run('library.trash', { ids: [imageId] });
    expect((await check([fresh]))[0]).toMatchObject({ imageId: null, deleted: true });
    const again = await sendSync(fresh, { album: p, clientKey: '1000000121', fileName: '151111643_p0.png' });
    expect([again.begin.status, again.complete]).toEqual(['imported', null]);

    // 内容和哈希对不上被拒（failed）：同一个文件（client_key + sha256）再来时接着用那一行，不会撞唯一索引
    const bad = await png();
    const b1 = (
      await lan('POST', '/api/uploads', {
        batchId: randomUUID(),
        sha256: sha256Hex(bad),
        size: bad.length,
        fileName: 'x.png',
        album: p,
        clientKey: '7',
      })
    ).json() as UploadBeginResult;
    const wrong = Buffer.from(bad);
    wrong.writeUInt8(wrong.readUInt8(wrong.length - 1) ^ 0xff, wrong.length - 1);
    await lan('PUT', `/api/uploads/${b1.uploadId}?offset=0`, wrong);
    expect((await lan('POST', `/api/uploads/${b1.uploadId}/complete`)).statusCode).toBe(400);
    const retry = await sendSync(bad, { album: p, clientKey: '7', fileName: 'x.png' });
    expect(retry.begin).toMatchObject({ uploadId: b1.uploadId, received: 0, status: 'receiving' });
    expect(retry.complete!.json()).toMatchObject({ status: 'imported' });
    expect(relOf(retry.complete!.json().imageId)).toBe('下载图片/平板导入/QQ浏览器/x.png');
  });

  it('没盘点过、没打开同步就传上来的相册：按路径取名，并且定下来', async () => {
    const sent = await sendSync(await png(), { album: 'Pictures/Twitter', clientKey: '9', fileName: 'a.png' });
    expect(relOf(sent.complete!.json().imageId)).toBe('下载图片/平板导入/Twitter/a.png');
  });
});
