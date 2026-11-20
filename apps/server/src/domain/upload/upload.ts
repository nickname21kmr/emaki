/**
 * 手机上传（B1，docs/mobile.md 5.4）：表 upload_batches、uploads 只有这里写（单一写入者）。
 *
 * 一个文件：check（电脑上有没有）→ begin（建一行，或者接着上次传了一半的）→ 一段段 receive（追加到 <数据目录>/uploads/<id>.part）
 * → complete（核对大小和 sha256，走「导入图片」入库：同名不同内容保留两份、保留手机上的修改时间；入库后的识别、分类、合集、查重由反应接上）。
 *
 * 判断「同一个文件」：
 * - 整个图库里有内容相同（sha256）的图：不再存一份，complete 回 existing 和那张的 id（导入图片本来就这样）；
 * - 这台设备传过的：有 client_key（相册同步）按 设备 + client_key + sha256，没有按 设备 + 相册 + sha256，begin 直接回 done。
 *   电脑上删掉的图因此不会被同步回来（同步相册在问的时候还会跳过回收站里有的，见 checkUploads 的 deleted）。
 *
 * 放到哪：设备的「上传到」（devices.upload_root_id / upload_dir，access/ 写），没设过是第一个自动识别的图库文件夹下的
 * 收件箱/手机/<设备名>；手动上传再进「手动上传」，同步的相册进为它定下来的文件夹（albums.ts）。
 * 按漫画导入的图库文件夹、漫画子文件夹不能当落点。
 */
import type { ID, UploadBatch, UploadBeginResult, UploadCheckResult, UploadTarget } from '@emaki/shared';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Device, Devices } from '../../access/devices.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { parseId } from '../../datasource/sqlite/sql.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { ROOT_ACTIVE, VISIBLE } from '../../readmodel/terms.ts';
import { importImages } from '../library/import.ts';
import { albumDir, normalizeAlbumPath } from './albums.ts';
import { normalizeSubdir } from '../library/move.ts';
import type { TrashImpl } from '../../services/trash/recycleBin.ts';

/** 手动上传放进的子文件夹 */
export const MANUAL_DIR = '手动上传';
/** 没传完的文件这么久没动静就清掉 */
export const STALE_MS = 7 * 24 * 3600_000;

const uploadsDir = (ctx: SqliteContext) => path.join(ctx.dataDir, 'uploads');
const partPath = (ctx: SqliteContext, id: string) => path.join(uploadsDir(ctx), `${id}.part`);
const now = (ctx: SqliteContext) => new Date(ctx.clock()).toISOString();

/**
 * 文件名、文件夹名里不能有的字符（Windows）换成下划线，去掉结尾的点和空格；不能是 . 或 ..。
 * 只取最后一段：手机给的名字里带路径的，路径不要
 */
export function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 120) : fallback;
}

interface Row {
  id: string;
  batch_id: string;
  device_id: string;
  album: string | null;
  client_key: string | null;
  sha256: string;
  size: number;
  file_name: string;
  modified_at: string | null;
  received: number;
  status: 'receiving' | 'imported' | 'existing' | 'failed';
  image_id: number | null;
}

// ---------------------------------------------------------------- 放到哪

interface RootRow {
  id: number;
  path: string;
  content_mode: string;
}

/** 这台设备的图实际放到哪（设过的图库文件夹停用了、移除了、变成按漫画导入了，退回默认） */
export function uploadTarget(ctx: SqliteContext, device: Device): UploadTarget {
  const roots = ctx.db.prepare(`SELECT id, path, content_mode FROM library_roots WHERE ${ROOT_ACTIVE('')} ORDER BY id`).all() as RootRow[];
  const chosen = device.uploadRootId === null ? undefined : roots.find((r) => r.id === device.uploadRootId && r.content_mode === 'auto');
  if (chosen)
    return { deviceId: device.id, rootId: String(chosen.id), rootPath: chosen.path, dir: device.uploadDir ?? '', isDefault: false };
  const auto = roots.find((r) => r.content_mode === 'auto');
  return {
    deviceId: device.id,
    rootId: auto ? String(auto.id) : null,
    rootPath: auto?.path ?? null,
    dir: `收件箱/手机/${safeName(device.name, device.id)}`,
    isDefault: true,
  };
}

/** 改「上传到」之前检查：图库文件夹在用、是自动识别的，相对路径合法、不在漫画子文件夹里。返回规范化的相对路径 */
export function checkUploadTarget(ctx: SqliteContext, rootId: ID, dir: string): { rootId: number; dir: string } {
  const id = parseId(rootId);
  const root =
    id === null
      ? undefined
      : (ctx.db.prepare(`SELECT id, path, content_mode FROM library_roots WHERE id = ? AND ${ROOT_ACTIVE('')}`).get(id) as
          RootRow | undefined);
  if (!root) throw new NotFoundError('图库文件夹');
  if (root.content_mode !== 'auto') throw new BadRequestError('「按漫画导入」的图库文件夹不能当上传的落点：传上来的图会被当成漫画页');
  const rel = normalizeSubdir(dir);
  if (ComicAreas.load(ctx.db).of(root.id, rel ? `${rel}/x.jpg` : 'x.jpg'))
    throw new BadRequestError('这个文件夹在「按漫画导入」的范围里，传上来的图会被当成漫画页，换一个文件夹');
  return { rootId: root.id, dir: rel };
}

// ---------------------------------------------------------------- 上传

/**
 * 这些图电脑上有没有：按 sha256 找图库里的图（排除了的也算有，回收站里的不算，但记下「删过」）。
 * 设备问的（device）另外回答那张图在不在它的「上传到」里、在哪个文件夹：同步相册的盘点据此跟着老图走（albums.ts）
 */
export function checkUploads(ctx: SqliteContext, files: { sha256: string }[], device?: Device): UploadCheckResult {
  const live = ctx.db.prepare(
    `SELECT i.id, i.root_id, i.rel_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.sha256 = ? AND ${VISIBLE} ORDER BY i.id LIMIT 50`,
  );
  const gone = ctx.db.prepare('SELECT 1 FROM images i WHERE i.sha256 = ? AND (i.trashed_at IS NOT NULL OR i.missing = 1) LIMIT 1').pluck();
  const target = device ? uploadTarget(ctx, device) : null;
  // 「上传到」的前缀（不分大小写：Windows 上路径不分大小写，手填的落点和磁盘上的写法可能不一样）
  const prefix = target?.rootId != null ? (target.dir ? `${target.dir.toLowerCase()}/` : '') : null;
  return {
    results: files.map((f) => {
      const hits = live.all(f.sha256) as { id: number; root_id: number; rel_path: string }[];
      const first = hits[0];
      if (!first) return { sha256: f.sha256, imageId: null, deleted: !!gone.get(f.sha256), dir: null };
      const inTarget =
        prefix === null ? undefined : hits.find((h) => String(h.root_id) === target?.rootId && h.rel_path.toLowerCase().startsWith(prefix));
      const rest = inTarget?.rel_path.slice(prefix?.length ?? 0);
      const dir = rest === undefined ? null : rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
      return { sha256: f.sha256, imageId: String((inTarget ?? first).id), deleted: false, dir };
    }),
  };
}

const SELECT =
  'SELECT id, batch_id, device_id, album, client_key, sha256, size, file_name, modified_at, received, status, image_id FROM uploads';

export interface BeginInput {
  batchId: string;
  sha256: string;
  size: number;
  fileName: string;
  modifiedAt?: string;
  album?: string;
  clientKey?: string;
}

/** 这一批（App 生成的 uuid）：第一个文件开始传时建；一批属于一台设备 */
function ensureBatch(ctx: SqliteContext, deviceId: string, batchId: string, album: string | null, at: string): void {
  const batch = ctx.db.prepare('SELECT device_id FROM upload_batches WHERE id = ?').get(batchId) as { device_id: string } | undefined;
  if (batch && batch.device_id !== deviceId) throw new ConflictError('这一批是另一台设备的');
  if (!batch)
    ctx.db
      .prepare('INSERT INTO upload_batches (id, device_id, album, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(batchId, deviceId, album, at, at);
  else ctx.db.prepare('UPDATE upload_batches SET updated_at = ? WHERE id = ?').run(at, batchId);
}

/**
 * 开始传一个文件，或者接着上次传了一半的；这台设备传过同一个文件的直接回 done。
 * 同步相册（有 client_key）的「传过」不看那张图还在不在：电脑上删掉的不会被同步回来；上次传失败的那一行接着用
 */
export function beginUpload(ctx: SqliteContext, deviceId: string, input: BeginInput): UploadBeginResult {
  cleanupStale(ctx);
  const album = input.album === undefined ? null : normalizeAlbumPath(input.album);
  const same = input.clientKey
    ? (ctx.db.prepare(`${SELECT} WHERE device_id = ? AND client_key = ? AND sha256 = ?`).get(deviceId, input.clientKey, input.sha256) as
        Row | undefined)
    : (ctx.db
        .prepare(
          `${SELECT} WHERE device_id = ? AND album IS ? AND sha256 = ? AND status IN ('imported', 'existing') ORDER BY created_at DESC LIMIT 1`,
        )
        .get(deviceId, album, input.sha256) as Row | undefined);
  if (same && (same.status === 'imported' || same.status === 'existing') && (same.image_id !== null || input.clientKey))
    return { uploadId: same.id, received: same.size, status: same.status, imageId: same.image_id === null ? null : String(same.image_id) };
  const at = now(ctx);
  // 同步相册上次传失败的（client_key 唯一，不能再插一行）：从头再传，算进这一批
  if (same && same.status === 'failed' && input.clientKey) {
    ctx.db.transaction(() => {
      ensureBatch(ctx, deviceId, input.batchId, album, at);
      ctx.db
        .prepare(
          `UPDATE uploads SET batch_id = ?, album = ?, file_name = ?, modified_at = ?, received = 0, status = 'receiving', error = NULL,
             image_id = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(input.batchId, album, safeName(input.fileName, 'image'), input.modifiedAt ?? null, at, same.id);
    })();
    mkdirSync(uploadsDir(ctx), { recursive: true });
    rmSync(partPath(ctx, same.id), { force: true });
    return { uploadId: same.id, received: 0, status: 'receiving', imageId: null };
  }
  // 传了一半的（同一台设备、同一个内容）：接着传。.part 不在了（被清掉）就从头
  const partial =
    same?.status === 'receiving'
      ? same
      : (ctx.db
          .prepare(`${SELECT} WHERE device_id = ? AND sha256 = ? AND status = 'receiving' ORDER BY updated_at DESC LIMIT 1`)
          .get(deviceId, input.sha256) as Row | undefined);
  if (partial) {
    const onDisk = existsSync(partPath(ctx, partial.id)) ? statSync(partPath(ctx, partial.id)).size : 0;
    if (onDisk !== partial.received) {
      ctx.db
        .prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?')
        .run(Math.min(onDisk, partial.size), now(ctx), partial.id);
      partial.received = Math.min(onDisk, partial.size);
    }
    return { uploadId: partial.id, received: partial.received, status: 'receiving', imageId: null };
  }
  const id = randomUUID();
  ctx.db.transaction(() => {
    ensureBatch(ctx, deviceId, input.batchId, album, at);
    ctx.db
      .prepare(
        `INSERT INTO uploads (id, batch_id, device_id, album, client_key, sha256, size, file_name, modified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.batchId,
        deviceId,
        album,
        input.clientKey ?? null,
        input.sha256,
        input.size,
        safeName(input.fileName, 'image'),
        input.modifiedAt ?? null,
        at,
        at,
      );
  })();
  mkdirSync(uploadsDir(ctx), { recursive: true });
  rmSync(partPath(ctx, id), { force: true });
  return { uploadId: id, received: 0, status: 'receiving', imageId: null };
}

function own(ctx: SqliteContext, deviceId: string, uploadId: string): Row {
  const row = ctx.db.prepare(`${SELECT} WHERE id = ?`).get(uploadId) as Row | undefined;
  if (!row || row.device_id !== deviceId) throw new NotFoundError('上传');
  return row;
}

/** 收一段：offset 必须等于已经收到的字节数（不等就 409，App 重新 begin 拿到断点再传） */
export async function receiveChunk(
  ctx: SqliteContext,
  deviceId: string,
  uploadId: string,
  offset: number,
  bytes: Buffer,
): Promise<{ received: number }> {
  const row = own(ctx, deviceId, uploadId);
  if (row.status !== 'receiving') throw new ConflictError('这个文件已经传完了');
  if (offset !== row.received) throw new ConflictError(`断点对不上：电脑上已收到 ${row.received} 字节，请从这里接着传`);
  if (!bytes.length) throw new BadRequestError('这一段是空的');
  if (offset + bytes.length > row.size) throw new BadRequestError('收到的字节比文件大小多');
  mkdirSync(uploadsDir(ctx), { recursive: true });
  const file = partPath(ctx, uploadId);
  const before = existsSync(file) ? (await stat(file)).size : 0;
  if (before !== offset) throw new ConflictError(`断点对不上：电脑上已收到 ${before} 字节，请从这里接着传`);
  await appendFile(file, bytes);
  const received = offset + bytes.length;
  ctx.db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(received, now(ctx), uploadId);
  return { received };
}

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

/** 传完了：核对大小和哈希，入库到这台设备的落点；.part 删掉 */
export async function completeUpload(
  ctx: SqliteContext,
  devices: Devices,
  deviceId: string,
  uploadId: string,
  opts: { trashImpl?: TrashImpl },
): Promise<{ status: 'imported' | 'existing'; imageId: string; message: string }> {
  const row = own(ctx, deviceId, uploadId);
  if ((row.status === 'imported' || row.status === 'existing') && row.image_id !== null)
    return { status: row.status, imageId: String(row.image_id), message: row.status === 'imported' ? '已入库' : '电脑上本来就有' };
  if (row.status !== 'receiving') throw new ConflictError('这个文件上传失败了，请重新传');
  const file = partPath(ctx, uploadId);
  const size = existsSync(file) ? statSync(file).size : -1;
  if (size !== row.size || row.received !== row.size)
    throw new ConflictError(`还没传完：电脑上已收到 ${Math.max(0, size)} / ${row.size} 字节`);
  const fail = (error: string) => {
    ctx.db.prepare("UPDATE uploads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(ctx), uploadId);
    rmSync(file, { force: true });
  };
  if ((await sha256File(file)) !== row.sha256) {
    fail('内容和 sha256 对不上');
    throw new BadRequestError('传上来的内容和 sha256 对不上，请重新传这个文件');
  }
  const device = devices.get(deviceId);
  if (!device) throw new NotFoundError('设备');
  const target = uploadTarget(ctx, device);
  if (target.rootId === null) throw new ConflictError('电脑上还没有可以放图的图库文件夹（自动识别的），请先在设置里添加');
  // 手动上传进「手动上传」；同步的相册进为它定下来的文件夹（albums.ts：跟着老图走，或者按相册路径取名）
  const dir = [target.dir, row.album === null ? MANUAL_DIR : albumDir(ctx, deviceId, row.album)].filter(Boolean).join('/');
  const result = await importImages(
    ctx,
    {
      rootId: target.rootId,
      dir,
      files: [{ path: file, fileName: row.file_name, modifiedAt: row.modified_at ?? undefined }],
      keepBoth: true,
    },
    opts,
  );
  const item = result.items[0];
  if (!item || item.status === 'failed') {
    const error = item?.error ?? '入库失败';
    fail(error);
    throw new BadRequestError(error);
  }
  const at = now(ctx);
  ctx.db
    .prepare('UPDATE uploads SET status = ?, image_id = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run(item.status, Number(item.imageId), at, uploadId);
  ctx.db.prepare('UPDATE upload_batches SET updated_at = ? WHERE id = ?').run(at, row.batch_id);
  rmSync(file, { force: true });
  return { status: item.status, imageId: item.imageId, message: item.status === 'imported' ? '已入库' : '电脑上本来就有' };
}

// ---------------------------------------------------------------- 电脑上看、撤销

export function listBatches(ctx: SqliteContext, limit = 30): UploadBatch[] {
  const batches = ctx.db
    .prepare(
      `SELECT b.id, b.device_id, COALESCE(d.name, b.device_id) AS device_name, b.album, b.created_at, b.updated_at, b.undone_at,
              SUM(u.status = 'imported') AS imported, SUM(u.status = 'existing') AS existing,
              SUM(u.status = 'failed') AS failed, SUM(u.status = 'receiving') AS receiving
       FROM upload_batches b LEFT JOIN devices d ON d.id = b.device_id LEFT JOIN uploads u ON u.batch_id = b.id
       GROUP BY b.id ORDER BY b.updated_at DESC LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    device_id: string;
    device_name: string;
    album: string | null;
    created_at: string;
    updated_at: string;
    undone_at: string | null;
    imported: number | null;
    existing: number | null;
    failed: number | null;
    receiving: number | null;
  }[];
  const images = ctx.db
    .prepare(
      "SELECT image_id FROM uploads WHERE batch_id = ? AND status = 'imported' AND image_id IS NOT NULL ORDER BY created_at LIMIT 12",
    )
    .pluck();
  const live = ctx.db
    .prepare(
      `SELECT COUNT(*) FROM uploads u JOIN images i ON i.id = u.image_id JOIN library_roots r ON r.id = i.root_id
       WHERE u.batch_id = ? AND u.status = 'imported' AND ${VISIBLE}`,
    )
    .pluck();
  return batches.map((b) => ({
    id: b.id,
    deviceId: b.device_id,
    deviceName: b.device_name,
    album: b.album,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    // 撤销过、而且新入库的图都不在图库里了才算撤销了（移到回收站那一步又被撤销的，图回来了）
    undoneAt: b.undone_at && !(live.get(b.id) as number) ? b.undone_at : null,
    imported: b.imported ?? 0,
    existing: b.existing ?? 0,
    failed: b.failed ?? 0,
    receiving: b.receiving ?? 0,
    imageIds: (images.all(b.id) as number[]).map(String),
  }));
}

/** 「撤销这一批」要移到回收站的图：这一批新入库、现在还在图库里的（本来就有的不动） */
export function batchImages(ctx: SqliteContext, batchId: string): number[] {
  if (!ctx.db.prepare('SELECT 1 FROM upload_batches WHERE id = ?').get(batchId)) throw new NotFoundError('上传批次');
  return ctx.db
    .prepare(
      `SELECT i.id FROM uploads u JOIN images i ON i.id = u.image_id JOIN library_roots r ON r.id = i.root_id
       WHERE u.batch_id = ? AND u.status = 'imported' AND ${VISIBLE}`,
    )
    .pluck()
    .all(batchId) as number[];
}

/** 记下这一批撤销过了（undone 为 false：撤销又被撤销了） */
export function markBatchUndone(ctx: SqliteContext, batchId: string, undone: boolean): void {
  ctx.db.prepare('UPDATE upload_batches SET undone_at = ? WHERE id = ?').run(undone ? now(ctx) : null, batchId);
}

// ---------------------------------------------------------------- 清理

let lastCleanup = 0;

/** 没传完、这么久没动静的：标成失败、删掉 .part；uploads 目录里不认识的 .part 也删掉。最多一小时做一次 */
export function cleanupStale(ctx: SqliteContext, force = false): void {
  const t = ctx.clock();
  if (!force && t - lastCleanup < 3600_000) return;
  lastCleanup = t;
  const cutoff = new Date(t - STALE_MS).toISOString();
  const stale = ctx.db.prepare("SELECT id FROM uploads WHERE status = 'receiving' AND updated_at < ?").pluck().all(cutoff) as string[];
  for (const id of stale) {
    ctx.db
      .prepare("UPDATE uploads SET status = 'failed', error = '太久没有传完', updated_at = ? WHERE id = ?")
      .run(new Date(t).toISOString(), id);
    rmSync(partPath(ctx, id), { force: true });
  }
  const dir = uploadsDir(ctx);
  if (!existsSync(dir)) return;
  const known = new Set(ctx.db.prepare("SELECT id FROM uploads WHERE status = 'receiving'").pluck().all() as string[]);
  for (const f of readdirSync(dir)) if (f.endsWith('.part') && !known.has(f.slice(0, -5))) rmSync(path.join(dir, f), { force: true });
}
