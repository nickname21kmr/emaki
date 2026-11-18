/**
 * 分析模块（docs/core-architecture.md 第 2.4、3.1 节，P4a，附录 #10、#23）：派生数据只由这里写——
 * 缩略图回写的 dHash、主色、生成时间、解码错误，帧数、相机，自动类型、是否动图（D5）、主题、画质分。
 *
 * 唯一的入口 analyze(tx, ids)：从现在的事实（路径、尺寸、格式、帧数、相机、识别标签、漫画区）重算这些图的自动类型、是否动图、主题、画质分，
 * 最终类型变了声明 image.kindChanged，是否动图变了声明 image.animatedChanged。谁都不再自己算分类：
 * - 反应 analyze（reactions.ts）：入库、文件内容变化（D1：扫描发现和用户替换一样）、移动、漫画区变化；
 * - 识别写入（每批，evidence/tagger.ts）、识别任务和缩略图任务读到的相机；
 * - 手动改类型（setManualKind：手动值或改回自动）、撤销切换导入方式（restoreKinds）、启动时版本过期的行（classifyStale）。
 * 文件读出来的帧数、相机（ProbeFacts）由调用方交进来，先写上再判类型；文件内容换了（fileChanged）先清掉旧文件算出来的像素派生，
 * 缩略图任务按新文件重新生成（缩略图按 sha 缓存，新 sha 自然是新文件）。
 * 是否动图（D5）只看帧数和格式，和类型互不影响：缩略图任务给旧图补读到的帧数走 recordFrames（只写帧数和是否动图，不重判类型）。
 *
 * 缩略图任务的像素结果（recordPixels、recordDecodeError）按 sha 回写、不传播：看图时生成缩略图不应该让前端整页重新拉取；
 * 只有类型、是否动图变了才传播（P2 的约定）。
 */
import type { ContentKind, ImageFormat } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { UndoRecorder } from '../../datasource/sqlite/undo.ts';
import type { ProbeFacts } from '../../propagation/changes.ts';
import { stmt, type DomainTx } from '../tx.ts';
import { isAnimated } from '../../services/classify/rules.ts';
import { backfillClassification } from './classify.ts';

export interface AnalyzeOptions {
  /** 读文件头时拿到的帧数、相机：先写上再判类型 */
  probes?: readonly ProbeFacts[];
  /** 文件内容换了（D1）：清掉旧文件算出来的像素派生（dHash、主色、缩略图时间、解码错误） */
  fileChanged?: boolean;
  /** 不声明 image.kindChanged / image.animatedChanged：刚入库的图（后面的反应本来就按 image.added 处理） */
  quiet?: boolean;
  /** 刚识别完、手上已经有的标签（识别写入）：不再读库；识别失败的给空的 */
  tags?: ReadonlyMap<number, [string, number][]>;
}

const json = (ids: readonly number[]) => JSON.stringify(ids);

/** 最终类型和是否动图 */
interface KindFacts {
  kind: string;
  animated: number;
}

function finalKinds(db: Db, ids: readonly number[]): Map<number, KindFacts> {
  const rows = stmt(db, 'SELECT id, content_kind AS kind, animated FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json(ids)) as ({
    id: number;
  } & KindFacts)[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** 前后对比：最终类型变了的图声明 image.kindChanged，是否动图变了的声明 image.animatedChanged；返回类型变了的 */
function declareKindChanges(tx: DomainTx, ids: readonly number[], before: Map<number, KindFacts>): number[] {
  const after = finalKinds(tx.db, ids);
  const kind = ids.filter((id) => before.has(id) && after.get(id)?.kind !== before.get(id)!.kind);
  const animated = ids.filter((id) => before.has(id) && after.get(id)?.animated !== before.get(id)!.animated);
  tx.changed({ type: 'image.kindChanged', ids: kind });
  tx.changed({ type: 'image.animatedChanged', ids: animated });
  return kind;
}

/** 写读文件头时拿到的相机（分析的列）；不判类型（读到相机的由调用方接着交给 analyze 重判） */
export function recordCameras(db: Db, cameras: readonly { id: number; camera: string | null }[]): void {
  const camera = stmt(db, 'UPDATE images SET camera = @camera WHERE id = @id');
  for (const p of cameras) camera.run({ id: p.id, camera: p.camera });
}

/**
 * 给旧图补读到的帧数（缩略图任务）：写帧数和是否动图（D5），不重判类型——帧数不影响类型，已有的类型和判定依据原样保留。
 * 是否动图变了声明 image.animatedChanged（还没读过帧数的 GIF 先算动图，读到只有一帧就不是了）
 */
export function recordFrames(tx: DomainTx, frames: readonly { id: number; frames: number | null }[]): number[] {
  if (!frames.length) return [];
  const db = tx.db;
  const rows = stmt(db, 'SELECT id, format, animated FROM images WHERE id IN (SELECT value FROM json_each(?))').all(
    json(frames.map((f) => f.id)),
  ) as { id: number; format: ImageFormat; animated: number }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const write = stmt(db, 'UPDATE images SET frame_count = @frames, animated = @animated WHERE id = @id');
  const flipped: number[] = [];
  for (const f of frames) {
    const r = byId.get(f.id);
    if (!r) continue;
    const animated = isAnimated({ format: r.format, frames: f.frames }) ? 1 : 0;
    write.run({ id: f.id, frames: f.frames, animated });
    if (animated !== r.animated) flipped.push(f.id);
  }
  tx.changed({ type: 'image.animatedChanged', ids: flipped });
  return flipped;
}

/** 唯一的入口：重算这些图的派生数据；返回最终类型变了的图 */
export function analyze(tx: DomainTx, requested: readonly number[], opts: AnalyzeOptions = {}): number[] {
  // 给了 probes、但不在 requested 里的图（不应该有）一起重算：帧数和是否动图要一起写
  const ids = opts.probes?.length ? [...new Set([...requested, ...opts.probes.map((p) => p.id)])] : requested;
  if (!ids.length) return [];
  const db = tx.db;
  const before = opts.quiet ? null : finalKinds(db, ids);
  if (opts.fileChanged) {
    stmt(
      db,
      `UPDATE images SET dhash = NULL, dominant_color = NULL, thumb_at = NULL, decode_error = NULL
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(json(ids));
  }
  // 帧数、相机、是否动图和类型一条 UPDATE 写完（入库、内容变化时每张都有）
  const probes = opts.probes?.length ? new Map(opts.probes.map((p) => [p.id, p])) : undefined;
  backfillClassification(db, { ids: [...ids], probes, tags: opts.tags });
  if (!before) return [];
  return declareKindChanges(tx, ids, before);
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
  u.columns(
    'images',
    ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'animated', 'theme', 'art_score'],
    [...ids],
  );
  // 设成某一类只改类型；是否动图按帧数派生，手动改类型不动它（D5）
  if (value === 'auto') backfillClassification(db, { ids: [...ids] });
  else
    stmt(
      db,
      `UPDATE images SET content_kind = ?, content_kind_source = 'manual', content_kind_evidence = NULL
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(value, json(ids));
  return declareKindChanges(tx, ids, before);
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
    `UPDATE images SET content_kind = @content_kind, content_kind_source = @content_kind_source,
       content_kind_evidence = @content_kind_evidence, content_kind_version = @content_kind_version, theme = @theme, art_score = @art_score
     WHERE id = @id AND content_kind_manual = 0`,
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
