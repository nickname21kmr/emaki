/**
 * 手机上传（B1，docs/mobile.md 5.4）：执行函数只调用 domain/upload/。
 *
 * - check / begin / complete 是手机上的 App 调的：scope upload（设备默认有；AI 助手没有，不生成 MCP 工具），执行者是这台设备。
 *   一段段的字节不走注册表（请求体是二进制），见 http/uploads.ts 的 PUT /api/uploads/:id。
 * - 最近的批次、撤销一批、每台设备的「上传到」是电脑上「手机访问」用的：scope devices，只有本机入口能用。
 * - 同步相册（B2，docs/mobile.md 5.5）：App 报相册、盘点、状态（upload.reportAlbums，只有设备能调）；看和改同步设置
 *   （upload.albums、upload.setAlbums）scope upload：设备只能看、改自己的，电脑上（本机入口）给 deviceId 看、改任何一台。
 */
import type {
  AlbumSyncConfig,
  AlbumSyncInfo,
  MutationResult,
  UploadBatch,
  UploadBeginResult,
  UploadCheckResult,
  UploadCompleteResult,
  UploadTarget,
} from '@emaki/shared';
import {
  AlbumReportInput,
  AlbumSetInput,
  AlbumsQueryInput,
  DeviceUploadInput,
  EmptyInput,
  IdInput,
  UploadBatchesInput,
  UploadBeginInput,
  UploadCheckInput,
} from '@emaki/shared/schemas';
import type { Device } from '../access/devices.ts';
import { albumConfig, albumInfo, reportAlbums, setAlbums } from '../domain/upload/albums.ts';
import { deviceIdOf, currentActor } from '../propagation/actor.ts';
import { BadRequestError, NotFoundError } from '../http/errors.ts';
import {
  batchImages,
  beginUpload,
  checkUploads,
  checkUploadTarget,
  completeUpload,
  listBatches,
  markBatchUndone,
  uploadTarget,
} from '../domain/upload/upload.ts';
import { trashImages } from './library.ts';
import { defineCommand, defineQuery } from './registry.ts';

/** 执行者必须是一台设备（局域网入口上的 App）：本机入口上没有「哪台设备」，不知道放到哪 */
function uploader(): string {
  const id = deviceIdOf(currentActor());
  if (!id) throw new BadRequestError('只有手机上的 App 能上传（通过手机访问的局域网入口）');
  return id;
}

/** 同步相册看、改的是哪台设备：设备只能是自己（给了别的 id 当作没有这台）；电脑上（本机入口）要给 deviceId */
function albumDevice(devices: { get(id: string): Device | null | undefined }, deviceId: string | undefined): Device {
  const self = deviceIdOf(currentActor());
  if (self && deviceId && deviceId !== self) throw new NotFoundError('设备');
  const id = self ?? deviceId;
  if (!id) throw new BadRequestError('要给 deviceId（哪台设备的同步相册）');
  const device = devices.get(id);
  if (!device) throw new NotFoundError('设备');
  return device;
}

/** 上传的步骤：不进撤销栈、不挡撤销（入库那一步的撤销在电脑上按批做） */
const step = { scope: 'upload', undoable: false, barrier: false, idempotent: false } as const;

export const uploadQueries = [
  defineQuery({
    name: 'upload.check',
    summary: '手机上传前先问：这些图（按 sha256）电脑上有没有，有的给图片 id，App 就不传了',
    input: UploadCheckInput,
    scope: 'upload',
    http: [{ method: 'POST', path: '/api/uploads/check' }],
    run(e, input): UploadCheckResult {
      const self = deviceIdOf(currentActor());
      return checkUploads(e.ctx, input.files, (self && e.access.devices.get(self)) || undefined);
    },
  }),
  defineQuery({
    name: 'upload.albums',
    summary: '一台设备的同步相册：手机上有哪些相册、盘点结果、哪些在同步、新图放到哪、App 的同步状态',
    input: AlbumsQueryInput,
    scope: 'upload',
    http: [{ method: 'GET', path: '/api/uploads/albums' }],
    run: (e, q): AlbumSyncInfo => albumInfo(e.ctx, albumDevice(e.access.devices, q.deviceId)),
  }),
  defineQuery({
    name: 'upload.batches',
    summary: '最近从手机传上来的批次：哪台设备、哪个相册、传了几张、几张本来就有，新入库的图',
    input: UploadBatchesInput,
    scope: 'devices',
    http: [{ method: 'GET', path: '/api/uploads/batches' }],
    run: (e, q): UploadBatch[] => listBatches(e.ctx, q.limit ?? 30),
  }),
  defineQuery({
    name: 'upload.targets',
    summary: '每台设备传上来的图放到哪（没设过的是默认：收件箱/手机/<设备名>）',
    input: EmptyInput,
    scope: 'devices',
    http: [{ method: 'GET', path: '/api/uploads/targets' }],
    run: (e): UploadTarget[] => e.access.devices.list().map((d) => uploadTarget(e.ctx, d)),
  }),
];

export const uploadCommands = [
  defineCommand({
    name: 'upload.begin',
    summary: '开始传一个文件，或者接着上次传了一半的（回已收到的字节数）；这台设备传过同一个文件的直接回 done 和图片 id',
    input: UploadBeginInput,
    ...step,
    http: [{ method: 'POST', path: '/api/uploads' }],
    run: (e, input): UploadBeginResult => beginUpload(e.ctx, uploader(), input),
  }),
  defineCommand({
    name: 'upload.complete',
    summary: '传完了：核对大小和 sha256，入库到这台设备的落点（同名不同内容保留两份，保留手机上的修改时间）',
    input: IdInput,
    ...step,
    http: [{ method: 'POST', path: '/api/uploads/:id/complete' }],
    async run(e, { id }): Promise<UploadCompleteResult> {
      e.requireLibraryFiles('上传图片');
      const r = await completeUpload(e.ctx, e.access.devices, uploader(), id, { trashImpl: e.ports.trashImpl });
      return { ok: true, ...r };
    },
  }),
  defineCommand({
    name: 'upload.reportAlbums',
    summary: 'App 报手机上的相册（张数、大小）、盘点结果、同步状态；回答 App 该同步哪些相册、什么条件下',
    input: AlbumReportInput,
    scope: 'upload',
    undoable: false,
    barrier: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/uploads/albums' }],
    run(e, input): AlbumSyncConfig & { ok: true; message: string } {
      const id = uploader();
      reportAlbums(e.ctx, id, input);
      return { ok: true, message: '已收到', ...albumConfig(e.ctx, id) };
    },
  }),
  defineCommand({
    name: 'upload.setAlbums',
    summary: '改同步相册：哪些相册同步、新图放到哪个文件夹（null 恢复自动）、只在 Wi-Fi / 充电时；App 下次同步时按新的',
    input: AlbumSetInput,
    scope: 'upload',
    undoable: false,
    barrier: false,
    idempotent: true,
    http: [{ method: 'PATCH', path: '/api/uploads/albums' }],
    run(e, input): { ok: true; message: string; info: AlbumSyncInfo } {
      const device = albumDevice(e.access.devices, input.deviceId);
      const c = setAlbums(e.ctx, device, input);
      const parts = [
        c.enabled && `开始同步 ${c.enabled} 个相册`,
        c.disabled && `停止同步 ${c.disabled} 个相册`,
        c.moved && `改了 ${c.moved} 个相册放到哪`,
      ].filter(Boolean);
      return { ok: true, message: parts.length ? parts.join('，') : '已保存', info: albumInfo(e.ctx, device) };
    },
  }),
  defineCommand({
    name: 'upload.undoBatch',
    summary: '撤销从手机传上来的一批：这一批新入库的图移到回收站（本来就有的不动），可以再撤销',
    input: IdInput,
    scope: 'devices',
    undoable: true,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/uploads/batches/:id/undo' }],
    async run(e, { id }): Promise<MutationResult> {
      const ids = batchImages(e.ctx, id);
      if (!ids.length) return { ok: true, message: '这一批没有还在图库里的新图', undoToken: null };
      const result = await trashImages(e, ids);
      markBatchUndone(e.ctx, id, true);
      return { ...result, message: `已把这一批的 ${ids.length} 张移到回收站` };
    },
  }),
  defineCommand({
    name: 'devices.setUpload',
    summary: '改一台设备传上来的图放到哪：图库文件夹 + 相对路径（rootId 为 null 恢复默认）。之后上传的才按新的',
    input: DeviceUploadInput,
    scope: 'devices',
    undoable: false,
    barrier: false,
    idempotent: false,
    http: [{ method: 'PATCH', path: '/api/devices/:id/upload' }],
    run(e, input): { ok: true; message: string; target: UploadTarget } {
      const checked = input.rootId === null ? null : checkUploadTarget(e.ctx, input.rootId, input.dir);
      const device = e.access.devices.setUpload(input.id, checked?.rootId ?? null, checked?.dir ?? '');
      if (!device) throw new NotFoundError('设备');
      const target = uploadTarget(e.ctx, device);
      return {
        ok: true,
        message: `「${device.name}」传上来的图之后放到 ${[target.rootPath, target.dir].filter(Boolean).join('/')}`,
        target,
      };
    },
  }),
];
