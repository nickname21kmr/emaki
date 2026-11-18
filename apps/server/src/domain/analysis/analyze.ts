/**
 * 分析模块（docs/core-architecture.md 第 2.4、3.1 节，P4a，附录 #10、#23）：派生数据只由这里写——
 * 缩略图回写的 dHash、主色、生成时间、解码错误，帧数、相机，自动类型、主题、画质分。
 *
 * 唯一的入口 analyze(tx, ids)：从现在的事实（路径、尺寸、格式、帧数、相机、识别标签、漫画区）重算这些图的自动类型、主题、画质分，
 * 最终类型变了声明 image.kindChanged。谁都不再自己算分类：
 * - 反应 analyze（reactions.ts）：入库、文件内容变化（D1：扫描发现和用户替换一样）、移动、漫画区变化；
 * - 识别写入（每批，evidence/tagger.ts）、识别任务和缩略图任务读到的帧数、相机；
 * - 手动改类型（setManualKind：手动值或改回自动）、撤销切换导入方式（restoreKinds）、启动时版本过期的行（classifyStale）。
 * 文件读出来的帧数、相机（ProbeFacts）由调用方交进来，先写上再判类型；文件内容换了（fileChanged）先清掉旧文件算出来的像素派生，
 * 缩略图任务按新文件重新生成（缩略图按 sha 缓存，新 sha 自然是新文件）。
 *
 * 缩略图任务的像素结果（recordPixels、recordDecodeError）按 sha 回写、不传播：看图时生成缩略图不应该让前端整页重新拉取；
 * 只有类型变了才传播（P2 的约定）。
 */
import type { ContentKind } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { ProbeFacts } from '../../propagation/changes.ts';
import { stmt, type DomainTx } from '../tx.ts';
import { backfillClassification } from './classify.ts';

export interface AnalyzeOptions {
  /** 读文件头时拿到的帧数、相机：先写上再判类型 */
  probes?: readonly ProbeFacts[];
  /** 文件内容换了（D1）：清掉旧文件算出来的像素派生（dHash、主色、缩略图时间、解码错误） */
  fileChanged?: boolean;
  /** 不声明 image.kindChanged：刚入库的图（后面的反应本来就按 image.added 处理） */
  quiet?: boolean;
}

const json = (ids: readonly number[]) => JSON.stringify(ids);

function finalKinds(db: Db, ids: readonly number[]): Map<number, string> {
  const rows = stmt(db, 'SELECT id, content_kind FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json(ids)) as { id: number; content_kind: string }[];
  return new Map(rows.map((r) => [r.id, r.content_kind]));
}

/** 写读文件头时拿到的帧数、相机（分析的列）；不判类型 */
export function recordProbes(db: Db, probes: readonly ProbeFacts[]): void {
  const frames = stmt(db, 'UPDATE images SET frame_count = @frames WHERE id = @id');
  const camera = stmt(db, 'UPDATE images SET camera = @camera WHERE id = @id');
  for (const p of probes) {
    if (p.frames !== undefined) frames.run({ id: p.id, frames: p.frames });
    if (p.camera !== undefined) camera.run({ id: p.id, camera: p.camera });
  }
}

/** 唯一的入口：重算这些图的派生数据；返回最终类型变了的图 */
export function analyze(tx: DomainTx, ids: readonly number[], opts: AnalyzeOptions = {}): number[] {
  if (!ids.length) return [];
  const db = tx.db;
  const before = opts.quiet ? null : finalKinds(db, ids);
  if (opts.fileChanged) {
    stmt(db, 'UPDATE images SET dhash = NULL, dominant_color = NULL, thumb_at = NULL, decode_error = NULL WHERE id IN (SELECT value FROM json_each(?))').run(
      json(ids),
    );
  }
  if (opts.probes?.length) recordProbes(db, opts.probes);
  backfillClassification(db, { ids: [...ids] });
  if (!before) return [];
  const after = finalKinds(db, ids);
  const changed = ids.filter((id) => before.has(id) && after.get(id) !== before.get(id));
  tx.changed({ type: 'image.kindChanged', ids: changed });
  return changed;
}

/** 版本过期（或从没判过）的行按现在的规则重算（启动时，见 propagation/versions.ts） */
export function classifyStale(db: Db): { rows: number; ms: number } {
  return backfillClassification(db);
}

/**
 * 手动改类型（T27 第 9 条）：手动标记（content_kind_manual）是归类的决定，由调用方先经 curation/kinds.ts 写好；
 * 这里写最终类型：设成某一类时类型就是它（来源 manual），改回自动时按规则当场重算。最终类型变了声明 image.kindChanged
 */
export function setManualKind(tx: DomainTx, u: UndoRecorder, ids: readonly number[], value: ContentKind | 'auto'): number[] {
  if (!ids.length) return [];
  const db = tx.db;
  const before = finalKinds(db, ids);
  u.columns('images', ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'theme', 'art_score'], [...ids]);
  if (value === 'auto') backfillClassification(db, { ids: [...ids] });
  else
    stmt(db, "UPDATE images SET content_kind = ?, content_kind_source = 'manual', content_kind_evidence = NULL WHERE id IN (SELECT value FROM json_each(?))").run(
      value,
      json(ids),
    );
  const after = finalKinds(db, ids);
  const changed = ids.filter((id) => before.get(id) !== after.get(id));
  tx.changed({ type: 'image.kindChanged', ids: changed });
  return changed;
}

/** 撤销切换导入方式时按快照写回的类型列（期间没重新识别过、没手动改过类型的行） */
export interface KindSnapshot {
  id: number;
  content_kind: string;
  content_kind_source: string | null;
  content_kind_evidence: string | null;
  content_kind_version: number | null;
  theme: string | null;
  art_score: number | null;
}

/** 按快照写回类型（撤销事务里，只还原事实；之后由调用方对一遍漫画区） */
export function restoreKinds(db: Db, rows: readonly KindSnapshot[]): void {
  const upd = stmt(
    db,
    `UPDATE images SET content_kind = @content_kind, content_kind_source = @content_kind_source, content_kind_evidence = @content_kind_evidence,
       content_kind_version = @content_kind_version, theme = @theme, art_score = @art_score WHERE id = @id AND content_kind_manual = 0`,
  );
  for (const r of rows)
    upd.run({
      id: r.id,
      content_kind: r.content_kind,
      content_kind_source: r.content_kind_source,
      content_kind_evidence: r.content_kind_evidence,
      content_kind_version: r.content_kind_version,
      theme: r.theme,
      art_score: r.art_score,
    });
}

/** 缩略图任务算出的像素派生：按 sha 写（完全重复的图共用一份缩略图） */
export function recordPixels(db: Db, sha: string, px: { dominantColor: string; dhash: string; at: string }): void {
  stmt(db, 'UPDATE images SET dominant_color = @c, dhash = @h, thumb_at = @at, decode_error = NULL WHERE sha256 = @sha').run({
    c: px.dominantColor,
    h: px.dhash,
    at: px.at,
    sha,
  });
}

/** 解不了的图：记下原因，缩略图任务不再挑它（文件内容变了会清掉，见 analyze 的 fileChanged） */
export function recordDecodeError(db: Db, sha: string, message: string): void {
  stmt(db, 'UPDATE images SET decode_error = ? WHERE sha256 = ?').run(message, sha);
}

/** 不是 JPEG 的图没有 EXIF 相机：直接记成读过（''），相机回填不再读文件 */
export function markNonJpegCameras(db: Db): void {
  stmt(db, "UPDATE images SET camera = '' WHERE camera IS NULL AND format <> 'jpeg'").run();
}
