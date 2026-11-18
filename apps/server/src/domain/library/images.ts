/**
 * 图库与文件模块：图片行的观测（docs/core-architecture.md 第 2.1、2.4 节，P4a）。
 * images 的观测列（路径、文件名、尺寸、大小、格式、sha256、入库时间、修改时间、丢失、回收站）和整行的新增只在 domain/library/ 里写。
 *
 * - 入库：新行只写观测（加上文件名解析出的来源、漫画区的初始分级这两个随行创建的初值），声明 image.added 带上读文件头拿到的帧数、相机；
 *   类型、主题、画质分由分析模块的反应写（analysis/reactions.ts），不再在插入时顺手算（附录 #23）。
 * - 文件内容变了（D1）：扫描发现和用户替换都走 recordFileChanged——只改观测列，声明 image.fileChanged（带 reason、新旧 sha），
 *   派生数据重算、识别过期、画师重认、查重标记、合集都由反应做，两条路完全一样（附录 #10）。
 * - 丢弃的行（回收站规则，附录 #23）：用户移进回收站、文件也已经离开原位（送进了系统回收站，或扫描确认不在了）的行，
 *   不再参与任何匹配；同一个位置又出现文件时这行让出路径（releasePath），文件作为新图入库，不复活旧 id 和旧关联。
 */
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { FileChangeReason, FileVersion, ProbeFacts } from '../../propagation/changes.ts';
import { stmt, type DomainTx } from '../tx.ts';

/** 新入库的一行（扫描和显式导入共用） */
export interface NewImageRow {
  rootId: number;
  relPath: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  sha256: string;
  addedAt: string;
  modifiedAt: string;
  /** 文件名解析出的来源（证据模块的列，随行创建的初值；之后改来源走证据 / 归类模块） */
  site: string | null;
  postId: string | null;
  artist: string | null;
  url: string | null;
  /** 漫画区的初始分级（归类模块的列，随行创建的初值） */
  rating: string;
}

const INSERT_SQL = `INSERT INTO images (root_id, rel_path, file_name, width, height, bytes, format, sha256,
  source_site, source_post_id, source_artist, source_url, added_at, modified_at, rating)
  VALUES (@rootId, @relPath, @fileName, @width, @height, @bytes, @format, @sha256,
  @site, @postId, @artist, @url, @addedAt, @modifiedAt, @rating)`;

/** 插入一行，返回新 id。插完一批用 declareAdded 声明 */
export function insertImage(db: Db, row: NewImageRow): number {
  return Number(stmt(db, INSERT_SQL).run(row).lastInsertRowid);
}

/** 新入库：排除规则、合集、缩略图和识别排队、查重标记由反应处理；类型由分析模块按 probes（帧数、相机）判 */
export function declareAdded(tx: DomainTx, ids: readonly number[], probes: readonly ProbeFacts[]): void {
  tx.changed({ type: 'image.added', ids: [...ids], probes: [...probes] });
}

/** 文件内容变化之后的观测（同一个 id） */
export interface ObservedContent {
  id: number;
  width: number;
  height: number;
  bytes: number;
  format: string;
  sha256: string;
  modifiedAt: string;
  /** 用户替换换了格式时扩展名跟着变（扫描发现的变化路径不变，不给） */
  relPath?: string;
  fileName?: string;
}

/**
 * 同一 id 的文件内容变了（D1）：扫描发现、用户替换都走这里，处理完全相同——只改观测列（扫描发现的还把丢失、回收站清掉：文件就在这里），
 * 声明 image.fileChanged（reason 只记录在案）。files 带新旧 sha；probes 是读新文件头拿到的帧数、相机
 */
export function recordFileChanged(tx: DomainTx, rows: readonly ObservedContent[], reason: FileChangeReason, probes: readonly ProbeFacts[] = []): void {
  if (!rows.length) return;
  const db = tx.db;
  const before = new Map(
    (stmt(db, 'SELECT id, sha256 FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(rows.map((r) => r.id))) as {
      id: number;
      sha256: string;
    }[]).map((r) => [r.id, r.sha256]),
  );
  const upd = stmt(
    db,
    `UPDATE images SET width = @width, height = @height, bytes = @bytes, format = @format, sha256 = @sha256, modified_at = @modifiedAt,
       rel_path = COALESCE(@relPath, rel_path), file_name = COALESCE(@fileName, file_name), missing = 0, trashed_at = NULL
     WHERE id = @id`,
  );
  const files: FileVersion[] = [];
  for (const r of rows) {
    upd.run({ ...r, relPath: r.relPath ?? null, fileName: r.fileName ?? null });
    files.push({ id: r.id, before: before.get(r.id) ?? '', after: r.sha256 });
  }
  tx.changed({ type: 'image.fileChanged', ids: rows.map((r) => r.id), reason, files, probes: [...probes] });
}

/**
 * 内容没变、只是大小或修改时间不同（扫描发现）：只改这两列；文件就在这里，丢失、回收站清掉——原来标着的声明 image.returned
 */
export function recordMeta(tx: DomainTx, rows: readonly { id: number; bytes: number; modifiedAt: string }[]): void {
  if (!rows.length) return;
  const back = stmt(tx.db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND (missing = 1 OR trashed_at IS NOT NULL)')
    .pluck()
    .all(JSON.stringify(rows.map((r) => r.id))) as number[];
  const upd = stmt(tx.db, 'UPDATE images SET bytes = @bytes, modified_at = @modifiedAt, missing = 0, trashed_at = NULL WHERE id = @id');
  for (const r of rows) upd.run(r);
  tx.changed({ type: 'image.returned', ids: back });
}

/** 确认文件不在了（扫描）：标丢失，声明 image.gone；返回真的新标的 */
export function markGone(tx: DomainTx, ids: readonly number[]): number[] {
  if (!ids.length) return [];
  const gone = stmt(tx.db, 'SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND missing = 0').pluck().all(JSON.stringify(ids)) as number[];
  stmt(tx.db, 'UPDATE images SET missing = 1 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(gone));
  tx.changed({ type: 'image.gone', ids: gone });
  return gone;
}

/** 文件又在原处出现（扫描，大小和修改时间都没变）：清掉丢失、回收站，声明 image.returned */
export function markReturned(tx: DomainTx, ids: readonly number[]): void {
  if (!ids.length) return;
  stmt(tx.db, 'UPDATE images SET missing = 0, trashed_at = NULL WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
  tx.changed({ type: 'image.returned', ids: [...ids] });
}

/** 用户把这些图移到回收站（库里先标记，文件晚一点才真的移，见 pendingTrash.ts）。u 不为空时记撤销 */
export function markTrashed(tx: DomainTx, u: UndoRecorder | null, ids: readonly number[], at: string): void {
  if (!ids.length) return;
  u?.columns('images', ['trashed_at'], [...ids]);
  stmt(tx.db, 'UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(at, JSON.stringify(ids));
  tx.changed({ type: 'image.trashed', ids: [...ids] });
}

/**
 * 文件已经送进系统回收站：它确实不在原处了（丢失）。从这时起这行是「丢弃的行」，不再参与移动匹配，
 * 原位置再出现文件时也不复活它（见文件头）。只标用户移进回收站的行（期间被找回来的不动）
 */
export function markRecycled(db: Db, ids: readonly number[]): void {
  if (!ids.length) return;
  stmt(db, 'UPDATE images SET missing = 1 WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NOT NULL').run(JSON.stringify(ids));
}

/** 丢弃的行：用户移进了回收站、文件也已经不在原处（a 是 images 的别名） */
export const DISCARDED = (a = 'i') => `(${a}.trashed_at IS NOT NULL AND ${a}.missing = 1)`;

/**
 * 丢弃的行让出它的路径：同一个位置又出现了文件（重新下载了同名文件），新文件作为新图入库。
 * 旧行留着（已处理的重复组还要显示被删的图），路径挪到一个扫描永远不会进去的位置（以 . 开头的目录，扫描跳过）
 */
export function releasePath(db: Db, id: number): void {
  stmt(db, "UPDATE images SET rel_path = '.emaki-discarded/' || id || '/' || rel_path WHERE id = ? AND trashed_at IS NOT NULL").run(id);
}
