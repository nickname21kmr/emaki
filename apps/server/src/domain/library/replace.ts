/**
 * 用户替换文件（换成高清版）：同一个 id，文件换成新的（格式变了扩展名跟着变），可撤销（备份在数据目录里）。
 *
 * D1（P4a，附录 #10）：替换和扫描发现外部改了文件是同一件事——只改观测列（recordFileChanged），声明 image.fileChanged（reason replace），
 * 派生数据重算（缩略图、dHash、主色、帧数、相机、自动类型、主题、画质分）、这份文件版本的识别过期并重新排队、画师重认、查重标记、合集，
 * 都由反应做，和扫描完全一样；手动的决定（角色、收藏、分级、原创、来源、手动类型……）都挂在 id 上，原样保留；
 * 自动关联等新证据到了由 reevaluateAuto 按 D2 处理。撤销也是一次文件内容变化，同样处理。
 *
 * 备份：<dataDir>/image-replacements/<uuid>/original.bin + record.json（record 里记撤销令牌）。撤销令牌过期、用掉之后，
 * 缓存回收（collectReplacementBackups）才删它。
 */
import type { ID, ReplaceImageBody, ReplaceImageResult } from '@emaki/shared';
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { UndoStack } from '../../core/undo.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { sha256Buffer } from '../../services/fs/hash.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { probeImage, type Probe } from '../../services/image/probe.ts';
import { htmlAnimationCache } from '../../services/image/htmlAnimation.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { parseId } from '../../datasource/sqlite/sql.ts';
import { destination, imageBytes } from './import.ts';
import { assertFilesIdle } from './guard.ts';
import { recordFileChanged, type ObservedContent } from './images.ts';

/** 文件本身的样子（观测）加上读文件头拿到的帧数、相机：替换和撤销替换都按它写 */
interface Version {
  rel_path: string;
  file_name: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  sha256: string;
  frame_count: number | null;
  camera: string | null;
}
const COLUMNS = ['rel_path', 'file_name', 'width', 'height', 'bytes', 'format', 'sha256', 'frame_count', 'camera'] as const;
type Row = Version & { id: number; root_id: number; missing: number; trashed_at: string | null };
const MAX_BYTES = 128 * 1024 * 1024;
const BACKUP_DIR = 'image-replacements';

function target(ctx: SqliteContext, id: ID) {
  const n = parseId(id);
  const row =
    n === null ? undefined : (ctx.db.prepare(`SELECT id,root_id,missing,trashed_at,${COLUMNS.join(',')} FROM images WHERE id=?`).get(n) as Row | undefined);
  if (!row || row.missing || row.trashed_at) throw new NotFoundError('可替换的图片');
  const rel = String(row.rel_path),
    dir = path.posix.dirname(rel);
  const { root } = destination(ctx, String(row.root_id), dir === '.' ? '' : dir);
  const abs = toAbs(root.path, rel);
  if (lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) throw new BadRequestError('请选择图库中的普通图片文件');
  return { row, abs, root };
}

function unchangedFile(file: string, bytes: number, sha: string) {
  try {
    return statSync(file).size === bytes && bytes <= MAX_BYTES && sha256Buffer(readFileSync(file)) === sha;
  } catch {
    return false;
  }
}

/**
 * 发布新文件并在同一个事务里改行、声明变化，期间不让出事件循环（扫描、监听插不进来）。
 * 数据库或改名失败时把原文件放回去再报错。格式变了换扩展名，id 不变
 */
function swap(
  ctx: SqliteContext,
  id: number,
  from: string,
  to: string,
  bytes: Buffer,
  previous: Buffer,
  previousMtime: Date,
  next: Version,
  mtime?: Date,
) {
  const tmp = path.join(path.dirname(to), `.emaki-replace-${randomUUID()}.tmp`);
  let published = false,
    removed = false;
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' });
    if (mtime) utimesSync(tmp, mtime, mtime);
    if (from === to) {
      renameSync(tmp, to);
      published = true;
    } else {
      try {
        linkSync(tmp, to);
      } catch (error) {
        if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        copyFileSync(tmp, to, constants.COPYFILE_EXCL);
        if (mtime) utimesSync(to, mtime, mtime);
      }
      published = true;
    }
    const observed: ObservedContent = {
      id,
      width: next.width,
      height: next.height,
      bytes: next.bytes,
      format: next.format,
      sha256: next.sha256,
      modifiedAt: statSync(to).mtime.toISOString(),
      relPath: next.rel_path,
      fileName: next.file_name,
    };
    // 和扫描发现的内容变化同一条路（D1）：派生数据、识别、画师、查重、合集都由反应处理
    ctx.apply(() => {
      recordFileChanged(ctx, [observed], 'replace', [{ id, frames: next.frame_count, camera: next.camera }]);
      if (from !== to) {
        unlinkSync(from);
        removed = true;
      }
    });
  } catch (error) {
    if (published) {
      if (from === to || removed) {
        // 同一个目录里改名：补偿也是原子的
        const rollback = path.join(path.dirname(from), `.emaki-restore-${randomUUID()}.tmp`);
        try {
          writeFileSync(rollback, previous, { flag: 'wx' });
          utimesSync(rollback, previousMtime, previousMtime);
          renameSync(rollback, from);
        } finally {
          if (existsSync(rollback)) unlinkSync(rollback);
        }
      }
      if (from !== to) unlinkSync(to);
    }
    throw error;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

const versionOf = (probe: Probe, rel: string, bytes: number, sha: string): Version => ({
  rel_path: rel,
  file_name: path.posix.basename(rel),
  width: probe.width,
  height: probe.height,
  bytes,
  format: probe.format,
  sha256: sha,
  frame_count: probe.pages,
  camera: probe.camera,
});

export async function replaceImage(ctx: SqliteContext, id: ID, body: ReplaceImageBody): Promise<ReplaceImageResult> {
  const bytes = await imageBytes(body.path),
    probe = await probeImage(bytes),
    sha = sha256Buffer(bytes);
  if (probe.format === 'html') await htmlAnimationCache(bytes, ctx.dataDir, sha);
  let old = target(ctx, id);
  const previous = await imageBytes(old.abs);
  // 异步的准备都做完了：再核对一遍现在的身份和内容
  old = target(ctx, id);
  assertFilesIdle(ctx, [old.row.id], '替换');
  if (sha256Buffer(previous) !== old.row.sha256 || !unchangedFile(old.abs, Number(old.row.bytes), String(old.row.sha256)))
    throw new ConflictError('原图片正在变化，请更新图库后重试');
  if (sha === old.row.sha256) return { ok: true, message: '这张图片已是该版本', undoToken: null, imageId: id, absPath: old.abs };
  const before = Object.fromEntries(COLUMNS.map((c) => [c, old.row[c]])) as unknown as Version;
  const oldMtime = statSync(old.abs).mtime;
  const ext = probe.format === 'jpeg' ? 'jpg' : probe.format;
  const oldRel = String(old.row.rel_path),
    oldExt = path.extname(oldRel);
  const rel = probe.format === old.row.format ? oldRel : (oldExt ? oldRel.slice(0, -oldExt.length) : oldRel) + `.${ext}`;
  const abs = toAbs(old.root.path, rel);
  const taken = () => ctx.db.prepare('SELECT 1 FROM images WHERE root_id=? AND rel_path=? COLLATE NOCASE AND id<>?').get(old.row.root_id, rel, old.row.id);
  if (abs !== old.abs && (existsSync(abs) || taken())) throw new ConflictError('新格式的同名文件已存在，请先选择要替换的图片');
  // 可以恢复的副本放在图库文件夹外面（数据目录里），进程重启也还在；撤销令牌过期后由缓存回收删掉
  const backupDir = path.join(ctx.dataDir, BACKUP_DIR, randomUUID());
  mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'original.bin');
  writeFileSync(backup, previous, { flag: 'wx' });
  const record: BackupRecord = {
    imageId: id,
    originalPath: old.abs,
    replacementPath: abs,
    sourcePath: body.path,
    at: new Date(ctx.clock()).toISOString(),
    media: before,
  };
  const recordFile = path.join(backupDir, 'record.json');
  writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' });
  swap(ctx, old.row.id, old.abs, abs, bytes, previous, oldMtime, versionOf(probe, rel, bytes.length, sha));
  const previousSize = previous.length,
    replacementSize = bytes.length;
  const result = ctx.undo.result('已替换图片', () => {
    assertFilesIdle(ctx, [old.row.id], '撤销替换');
    const current = target(ctx, id);
    const moved = current.row.root_id !== old.row.root_id || current.row.rel_path !== rel || current.abs !== abs;
    if (moved || current.row.sha256 !== sha || !unchangedFile(abs, replacementSize, sha)) throw new ConflictError('图片位置或内容已变化，请查看当前图片后再处理');
    if (abs !== old.abs && existsSync(old.abs)) throw new ConflictError('原文件位置已有其他文件，请先处理重名文件');
    if (!unchangedFile(backup, previousSize, String(before.sha256))) throw new ConflictError('原版本备份无法读取');
    swap(ctx, old.row.id, abs, old.abs, readFileSync(backup), readFileSync(abs), statSync(abs).mtime, before, oldMtime);
  });
  // 记下撤销令牌：令牌还能用时缓存回收不删这份备份
  try {
    writeRecord(recordFile, { ...record, undoToken: result.undoToken });
  } catch (error) {
    console.warn(`[替换] 记撤销令牌失败（备份会留到令牌过期后再删）：${(error as Error).message}`);
  }
  return { ...result, imageId: id, absPath: abs };
}

interface BackupRecord {
  imageId: ID;
  originalPath: string;
  replacementPath: string;
  sourcePath: string;
  at: string;
  media: Version;
  /** 撤销令牌（P4a 起记；之前的备份没有） */
  undoToken?: string | null;
}

function writeRecord(file: string, record: BackupRecord): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { flag: 'wx' });
  renameSync(tmp, file);
}

/**
 * 替换备份的回收（缓存回收的一部分，见 analysis/cacheGc.ts 的 collectCaches）：只看 <dataDir>/image-replacements 下面、
 * 名字是 uuid 的目录，里面只能有 original.bin、record.json（和写 record 时的临时文件）；别的一概不碰。
 * 撤销令牌还能用（live）的留着；令牌已经用掉、过期（包括进程重启前发的）的删掉。
 * 还没来得及记令牌的（startedAt 之后、令牌写进 record 之前的一瞬间）留着。返回删掉的目录数和这些备份里原版本的 sha（还在等撤销的那些不算）
 */
export function collectReplacementBackups(
  dataDir: string,
  undo: Pick<UndoStack, 'status'>,
  startedAt: number,
): { removed: number; keptShas: Set<string> } {
  const root = path.join(dataDir, BACKUP_DIR);
  const keptShas = new Set<string>();
  let removed = 0;
  let names: string[];
  try {
    if (lstatSync(root).isSymbolicLink()) return { removed, keptShas };
    names = readdirSync(root);
  } catch {
    return { removed, keptShas };
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ALLOWED = /^(?:original\.bin|record\.json(?:\.[0-9a-f-]{36}\.tmp)?)$/i;
  for (const name of names) {
    if (!UUID.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const files = readdirSync(dir);
      if (files.some((f) => !ALLOWED.test(f) || !lstatSync(path.join(dir, f)).isFile())) continue;
      let record: BackupRecord | null = null;
      try {
        record = JSON.parse(readFileSync(path.join(dir, 'record.json'), 'utf8')) as BackupRecord;
      } catch {
        record = null;
      }
      const token = record?.undoToken ?? null;
      const live = token ? undo.status(token) === 'live' : st.mtimeMs >= startedAt;
      if (live) {
        if (record?.media?.sha256) keptShas.add(String(record.media.sha256));
        continue;
      }
      for (const f of files) rmSync(path.join(dir, f), { force: true });
      rmdirSync(dir);
      removed++;
    } catch (error) {
      console.warn(`[缓存回收] 跳过替换备份 ${name}：${(error as Error).message}`);
    }
  }
  return { removed, keptShas };
}
