/**
 * 同步相册（B2，docs/mobile.md 5.5）：表 device_albums、device_sync 只有这里写（单一写入者）。
 *
 * - App 报上来手机上的相册（一个相册 = 一个文件夹，不含子文件夹）、盘点结果、同步状态（reportAlbums）；
 * - 电脑上或手机上改哪些相册同步、新图放到哪、只在 Wi-Fi / 充电时（setAlbums）；
 * - 传上来的图放到「上传到」下的哪个文件夹（albumDir，upload.ts 的 completeUpload 用）。
 *
 * 新图放到哪（autoDir），第一次打开同步时定下来，之后不再自动变：
 * 1. 跟着老图走：盘点时这个相册里已经在电脑上的图，大部分（过半、至少 3 张）在「上传到」里的同一个文件夹 → 放那里；
 * 2. 没有老图：取手机路径里有意义的部分当文件夹名（albumFolderName：去掉 DCIM / Pictures / Download 这类标准目录、
 *    纯数字的编号、「图片收藏」这类泛称），和别的相册取出来的名字一样（不分大小写）就放到那个相册定下来的文件夹。
 *
 * 建议同步（suggests）：盘点过，电脑上已有的图过半（至少 3 张）在这台设备的「上传到」里，也就是以前拷过的相册。
 */
import type { AlbumDirReason, AlbumSyncConfig, AlbumSyncInfo, AlbumSyncState, DeviceAlbum } from '@emaki/shared';
import type { Device } from '../../access/devices.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { normalizeSubdir } from '../library/move.ts';
import { safeName, uploadTarget } from './upload.ts';

/** 跟着老图走、建议同步，至少要有这么多张作证 */
export const MIN_EVIDENCE = 3;
/** App 报的「正在盘点 / 同步」这么久没更新就不算在跑了（App 被系统杀掉了） */
export const STALE_RUNNING_MS = 15 * 60_000;

const now = (ctx: SqliteContext) => new Date(ctx.clock()).toISOString();

/** 手机上的相册路径：反斜杠换成正斜杠，去掉两头和重复的斜杠；不能有 . 和 .. 这样的段 */
export function normalizeAlbumPath(input: string): string {
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) throw new BadRequestError(`相册路径不对：${input}`);
  return parts.join('/');
}

/** 手机上的标准目录：在开头而且后面还有别的时去掉 */
const STANDARD_TOP = new Set(['dcim', 'pictures', 'download', 'downloads', 'documents', 'movies', 'android']);
/** 泛称：在哪都去掉（只剩它们时还是用它们） */
const GENERIC = new Set([
  '图片收藏',
  '图片',
  '收藏',
  '相册',
  '保存',
  'images',
  'image',
  'img',
  'photos',
  'photo',
  'pictures',
  'saved',
  'save',
  'media',
]);

/** 一段能不能当电脑上的文件夹名：Windows 不能有的字符换掉、不以点或 $ 开头（扫描器不进这种文件夹） */
function folderSegment(s: string): string | null {
  const cleaned = safeName(s, '').replace(/^[.$]+/, '');
  if (!cleaned) return null;
  try {
    return normalizeSubdir(cleaned) || null;
  } catch {
    return null;
  }
}

/**
 * 没有老图时新图放的文件夹名：手机路径里有意义的部分。
 * 'Download/QQBrowser/1700284633722/图片收藏' → 'QQBrowser'；'DCIM/tieba' → 'tieba'；'Download' → 'Download'；'考研/报名' → '考研/报名'
 */
export function albumFolderName(albumPath: string): string {
  const segs = albumPath.split('/').filter(Boolean);
  const meaningful = segs.filter((s, i) => {
    const l = s.toLowerCase();
    if (i === 0 && segs.length > 1 && STANDARD_TOP.has(l)) return false;
    if (/^\d{4,}$/.test(s)) return false; // 编号：账号、时间戳
    if (/^[a-z]\w*(\.\w+){2,}$/i.test(s)) return false; // 包名：com.tencent.mm
    return !GENERIC.has(l);
  });
  const picked = meaningful.length ? meaningful : [segs.find((s) => !/^\d+$/.test(s)) ?? segs[segs.length - 1] ?? ''];
  const parts = picked.map(folderSegment).filter((p): p is string => !!p);
  return parts.join('/') || '相册';
}

interface AlbumRow {
  device_id: string;
  path: string;
  name: string;
  count: number;
  bytes: number;
  latest_at: string | null;
  seen_at: string;
  gone_at: string | null;
  inv_total: number | null;
  inv_have: number | null;
  inv_in_target: number | null;
  inv_deleted: number | null;
  inv_new: number | null;
  inv_new_bytes: number | null;
  inv_folder: string | null;
  inv_folder_count: number | null;
  inventoried_at: string | null;
  sync: number;
  dir: string | null;
  dir_reason: AlbumDirReason | null;
  pending: number | null;
  rejected: number | null;
  synced_at: string | null;
}

interface SyncRow {
  device_id: string;
  wifi_only: number;
  charging_only: number;
  running: 'inventory' | 'sync' | null;
  done: number | null;
  total: number | null;
  error: string | null;
  summary: string | null;
  summary_at: string | null;
  reported_at: string | null;
  inventoried_at: string | null;
  synced_at: string | null;
}

const rowsOf = (ctx: SqliteContext, deviceId: string) =>
  ctx.db.prepare('SELECT * FROM device_albums WHERE device_id = ? ORDER BY sync DESC, count DESC, path').all(deviceId) as AlbumRow[];

/** 建议同步：以前拷过的相册（电脑上已有的图过半在这台设备的「上传到」里） */
export function suggests(r: Pick<AlbumRow, 'inventoried_at' | 'inv_have' | 'inv_in_target'>): boolean {
  const inTarget = r.inv_in_target ?? 0;
  return r.inventoried_at !== null && inTarget >= MIN_EVIDENCE && inTarget * 2 > (r.inv_have ?? 0);
}

/** 还没定下来时，新图会放到哪（跟着老图走 → 按路径取名、和同名的相册放一起） */
function autoDir(r: AlbumRow, rows: AlbumRow[]): { dir: string; reason: AlbumDirReason; note: string } {
  const folderCount = r.inv_folder_count ?? 0;
  if (r.inv_folder !== null && folderCount >= MIN_EVIDENCE && folderCount * 2 > (r.inv_in_target ?? 0)) {
    try {
      const dir = normalizeSubdir(r.inv_folder);
      return { dir, reason: 'history', note: `以前的 ${folderCount} 张都在这里` };
    } catch {
      // 文件夹名不合法（不该发生）：按名字
    }
  }
  const name = albumFolderName(r.path);
  const sibling = rows.find((o) => o.path !== r.path && o.dir !== null && albumFolderName(o.path).toLowerCase() === name.toLowerCase());
  if (sibling?.dir != null) return { dir: sibling.dir, reason: 'name', note: `和「${sibling.path}」放在一起` };
  return { dir: name, reason: 'name', note: '按相册路径取的名字' };
}

function fixedNote(r: AlbumRow): string {
  if (r.dir_reason === 'manual') return '你改的';
  if (r.dir_reason === 'history')
    return r.inv_folder === r.dir && r.inv_folder_count ? `以前的 ${r.inv_folder_count} 张都在这里` : '跟着老图';
  return '按相册路径取的名字';
}

function toAlbum(r: AlbumRow, rows: AlbumRow[]): DeviceAlbum {
  const fixed = r.dir !== null && r.dir_reason !== null;
  const auto = fixed ? null : autoDir(r, rows);
  return {
    path: r.path,
    name: r.name,
    count: r.count,
    bytes: r.bytes,
    latestAt: r.latest_at,
    gone: r.gone_at !== null,
    inventory:
      r.inventoried_at === null
        ? null
        : {
            total: r.inv_total ?? 0,
            have: r.inv_have ?? 0,
            inTarget: r.inv_in_target ?? 0,
            deleted: r.inv_deleted ?? 0,
            new: r.inv_new ?? 0,
            newBytes: r.inv_new_bytes ?? 0,
            folder: r.inv_folder,
            folderCount: r.inv_folder_count ?? 0,
            at: r.inventoried_at,
          },
    sync: r.sync === 1,
    dir: auto ? auto.dir : (r.dir as string),
    dirReason: auto ? auto.reason : (r.dir_reason as AlbumDirReason),
    dirFixed: fixed,
    dirNote: auto ? auto.note : fixedNote(r),
    suggested: suggests(r),
    pending: r.pending,
    rejected: r.rejected,
    syncedAt: r.synced_at,
  };
}

function syncRow(ctx: SqliteContext, deviceId: string): SyncRow {
  ctx.db.prepare('INSERT OR IGNORE INTO device_sync (device_id) VALUES (?)').run(deviceId);
  return ctx.db.prepare('SELECT * FROM device_sync WHERE device_id = ?').get(deviceId) as SyncRow;
}

function stateOf(ctx: SqliteContext, s: SyncRow): AlbumSyncState {
  // App 被系统杀掉了，「正在同步」就一直停在那：太久没报就不算在跑了
  const alive = s.reported_at !== null && ctx.clock() - Date.parse(s.reported_at) < STALE_RUNNING_MS;
  return {
    running: alive ? s.running : null,
    done: alive && s.running ? s.done : null,
    total: alive && s.running ? s.total : null,
    error: s.error,
    summary: s.summary,
    summaryAt: s.summary_at,
    reportedAt: s.reported_at,
    inventoriedAt: s.inventoried_at,
    syncedAt: s.synced_at,
  };
}

/** 一台设备的同步相册（电脑上和手机上的「同步相册」页面） */
export function albumInfo(ctx: SqliteContext, device: Device): AlbumSyncInfo {
  const rows = rowsOf(ctx, device.id);
  const s = syncRow(ctx, device.id);
  return {
    deviceId: device.id,
    deviceName: device.name,
    target: uploadTarget(ctx, device),
    wifiOnly: s.wifi_only === 1,
    chargingOnly: s.charging_only === 1,
    state: stateOf(ctx, s),
    albums: rows.map((r) => toAlbum(r, rows)),
  };
}

/** App 按它同步：哪些相册、什么条件下 */
export function albumConfig(ctx: SqliteContext, deviceId: string): AlbumSyncConfig {
  const s = syncRow(ctx, deviceId);
  const rows = ctx.db
    .prepare('SELECT path, sync FROM device_albums WHERE device_id = ? AND gone_at IS NULL ORDER BY path')
    .all(deviceId) as {
    path: string;
    sync: number;
  }[];
  return {
    wifiOnly: s.wifi_only === 1,
    chargingOnly: s.charging_only === 1,
    albums: rows.map((r) => ({ path: r.path, sync: r.sync === 1 })),
  };
}

export interface AlbumReport {
  albums: {
    path: string;
    name: string;
    count: number;
    bytes: number;
    latestAt?: string;
    inventory?: {
      total: number;
      have: number;
      inTarget: number;
      deleted: number;
      new: number;
      newBytes: number;
      folder: string | null;
      folderCount: number;
    };
    pending?: number;
    rejected?: number;
  }[];
  full: boolean;
  state?: { running: 'inventory' | 'sync' | null; done?: number; total?: number; error?: string | null; summary?: string | null };
}

/**
 * App 报相册：有就更新张数、大小，没有就新建；full（这是手机上全部的相册）时没列出的标成「手机上没有了」，
 * 其中没打开同步的直接删掉。带盘点的记下盘点结果；带 pending 的是同步完了。state 是 App 现在在做什么
 */
export function reportAlbums(ctx: SqliteContext, deviceId: string, input: AlbumReport): void {
  const at = now(ctx);
  ctx.db.transaction(() => {
    const upsert = ctx.db.prepare(
      `INSERT INTO device_albums (device_id, path, name, count, bytes, latest_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, path) DO UPDATE SET name = excluded.name, count = excluded.count, bytes = excluded.bytes,
         latest_at = excluded.latest_at, seen_at = excluded.seen_at, gone_at = NULL`,
    );
    const inventory = ctx.db.prepare(
      `UPDATE device_albums SET inv_total = ?, inv_have = ?, inv_in_target = ?, inv_deleted = ?, inv_new = ?, inv_new_bytes = ?,
         inv_folder = ?, inv_folder_count = ?, inventoried_at = ? WHERE device_id = ? AND path = ?`,
    );
    const pending = ctx.db.prepare('UPDATE device_albums SET pending = ?, rejected = ?, synced_at = ? WHERE device_id = ? AND path = ?');
    const paths: string[] = [];
    let inventoried = false;
    let synced = false;
    for (const a of input.albums) {
      const p = normalizeAlbumPath(a.path);
      paths.push(p);
      upsert.run(deviceId, p, a.name.trim() || p, a.count, a.bytes, a.latestAt ?? null, at);
      if (a.inventory) {
        const i = a.inventory;
        let folder: string | null = null;
        if (i.folder !== null)
          try {
            folder = normalizeSubdir(i.folder);
          } catch {
            folder = null;
          }
        inventory.run(
          i.total,
          i.have,
          i.inTarget,
          i.deleted,
          i.new,
          i.newBytes,
          folder,
          folder === null ? 0 : i.folderCount,
          at,
          deviceId,
          p,
        );
        inventoried = true;
      }
      if (a.pending !== undefined) {
        pending.run(a.pending, a.rejected ?? 0, at, deviceId, p);
        synced = true;
      }
    }
    if (input.full) {
      const list = JSON.stringify(paths);
      ctx.db
        .prepare('DELETE FROM device_albums WHERE device_id = ? AND sync = 0 AND path NOT IN (SELECT value FROM json_each(?))')
        .run(deviceId, list);
      ctx.db
        .prepare(
          'UPDATE device_albums SET gone_at = ? WHERE device_id = ? AND gone_at IS NULL AND path NOT IN (SELECT value FROM json_each(?))',
        )
        .run(at, deviceId, list);
    }
    syncRow(ctx, deviceId);
    const st = input.state;
    if (st)
      ctx.db
        .prepare(
          `UPDATE device_sync SET running = @running, done = @done, total = @total, error = @error, summary = COALESCE(@summary, summary),
             summary_at = CASE WHEN @summary IS NULL THEN summary_at ELSE @at END, reported_at = @at WHERE device_id = @id`,
        )
        .run({
          running: st.running,
          done: st.done ?? null,
          total: st.total ?? null,
          error: st.error ?? null,
          summary: st.summary ?? null,
          at,
          id: deviceId,
        });
    else ctx.db.prepare('UPDATE device_sync SET reported_at = ? WHERE device_id = ?').run(at, deviceId);
    if (inventoried && input.full) ctx.db.prepare('UPDATE device_sync SET inventoried_at = ? WHERE device_id = ?').run(at, deviceId);
    if (synced) ctx.db.prepare('UPDATE device_sync SET synced_at = ? WHERE device_id = ?').run(at, deviceId);
  })();
}

export interface AlbumChanges {
  albums: { path: string; sync?: boolean; dir?: string | null }[];
  wifiOnly?: boolean;
  chargingOnly?: boolean;
}

/**
 * 改同步设置。打开同步时新图放到哪定下来（autoDir）；dir 给字符串是用户改的，给 null 恢复自动（同步开着就马上重新定）。
 * 改的文件夹不能在「按漫画导入」的范围里。返回改了几个相册
 */
export function setAlbums(ctx: SqliteContext, device: Device, input: AlbumChanges): { enabled: number; disabled: number; moved: number } {
  const target = uploadTarget(ctx, device);
  const counts = { enabled: 0, disabled: 0, moved: 0 };
  ctx.db.transaction(() => {
    syncRow(ctx, device.id);
    if (input.wifiOnly !== undefined)
      ctx.db.prepare('UPDATE device_sync SET wifi_only = ? WHERE device_id = ?').run(input.wifiOnly ? 1 : 0, device.id);
    if (input.chargingOnly !== undefined)
      ctx.db.prepare('UPDATE device_sync SET charging_only = ? WHERE device_id = ?').run(input.chargingOnly ? 1 : 0, device.id);
    const fix = ctx.db.prepare('UPDATE device_albums SET dir = ?, dir_reason = ? WHERE device_id = ? AND path = ?');
    // 先改文件夹、再开关：同一次里打开好几个同名的相册，后面的跟着前面定下来的
    for (const a of input.albums) {
      const p = normalizeAlbumPath(a.path);
      const row = ctx.db.prepare('SELECT * FROM device_albums WHERE device_id = ? AND path = ?').get(device.id, p) as AlbumRow | undefined;
      if (!row) throw new NotFoundError(`相册「${p}」`);
      if (a.dir !== undefined) {
        if (a.dir === null) fix.run(null, null, device.id, p);
        else {
          const dir = normalizeSubdir(a.dir);
          if (
            target.rootId !== null &&
            ComicAreas.load(ctx.db).of(Number(target.rootId), [target.dir, dir, 'x.jpg'].filter(Boolean).join('/'))
          )
            throw new BadRequestError(`「${dir}」在「按漫画导入」的范围里，传上来的图会被当成漫画页，换一个文件夹`);
          fix.run(dir, 'manual', device.id, p);
        }
        counts.moved++;
      }
      if (a.sync !== undefined && a.sync !== (row.sync === 1)) {
        ctx.db.prepare('UPDATE device_albums SET sync = ? WHERE device_id = ? AND path = ?').run(a.sync ? 1 : 0, device.id, p);
        if (a.sync) counts.enabled++;
        else counts.disabled++;
      }
    }
    // 开着同步、文件夹还没定的：现在定下来（之后不再自动变）
    for (;;) {
      const rows = rowsOf(ctx, device.id);
      const open = rows.find((r) => r.sync === 1 && (r.dir === null || r.dir_reason === null));
      if (!open) break;
      const auto = autoDir(open, rows);
      fix.run(auto.dir, auto.reason, device.id, open.path);
    }
  })();
  return counts;
}

/** 这个相册传上来的图放到「上传到」下的哪个文件夹；还没定下来（没打开同步就传了）的现在定下来 */
export function albumDir(ctx: SqliteContext, deviceId: string, albumPath: string): string {
  const p = normalizeAlbumPath(albumPath);
  const rows = rowsOf(ctx, deviceId);
  const row = rows.find((r) => r.path === p);
  if (row?.dir != null && row.dir_reason !== null) return row.dir;
  if (!row) return albumFolderName(p);
  const auto = autoDir(row, rows);
  ctx.db
    .prepare('UPDATE device_albums SET dir = ?, dir_reason = ? WHERE device_id = ? AND path = ?')
    .run(auto.dir, auto.reason, deviceId, p);
  return auto.dir;
}
