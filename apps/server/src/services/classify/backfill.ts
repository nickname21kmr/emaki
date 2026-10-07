/**
 * 内容类型 + 主题 + art_score 的计算与回填（T27、T27 补充）。全项目只有这一个入口：
 * - 启动时在 migrate 之后、HTTP 监听之前同步跑（BI-4：全库约 1 秒），选 content_kind_version 过期的行；
 * - 用户把类型改回「自动」时按 ids 当场重算；
 * - tagger writer 写完标签后用 computeClassification + writeClassification 在同一事务里写。
 *
 * content_kind_manual=1 的行只写 theme、art_score（manual 只保护类型）；任何重算都不动 shelved_at。
 */
import type { ContentKind, ContentKindSource, ImageFormat } from '@emaki/shared';
import { transact, type Db, type Statement } from '../../db/connection.ts';
import { classifyContent, CLASSIFIER_VERSION, SIGNAL_TAGS } from './rules.ts';
import { artScore, classifyTheme, THEME_TAG_NAMES, type StoredTheme } from './theme.ts';

export interface ClassRow {
  id: number;
  file_name: string;
  rel_path: string;
  width: number;
  height: number;
  format: ImageFormat;
  camera: string | null;
  content_kind_manual: number;
  tagged_at: string | null;
  /** 所在图库文件夹按漫画导入（1） */
  comic_root: number;
}

export interface Classification {
  kind: ContentKind;
  source: ContentKindSource;
  evidence: string | null;
  theme: StoredTheme | null;
  artScore: number | null;
}

/** 只能接在 FROM images 后面（不带别名）：comic_root 用相关子查询从图库文件夹取 */
export const CLASS_COLS = `id, file_name, rel_path, width, height, format, camera, content_kind_manual, tagged_at,
  COALESCE((SELECT r.content_mode = 'comic' FROM library_roots r WHERE r.id = images.root_id), 0) AS comic_root`;
/** 分类、主题、质量分用到的全部标签名：回填只读这些（RV-T-6） */
export const CLASSIFY_TAG_NAMES: readonly string[] = [...new Set([...SIGNAL_TAGS, ...THEME_TAG_NAMES])];

/** tags 为 null = 还没打标签（theme、art_score 也写 NULL） */
export function computeClassification(r: ClassRow, tags: [string, number][] | null): Classification {
  const tagged = r.tagged_at !== null && tags !== null;
  const c = classifyContent({
    fileName: r.file_name,
    relPath: r.rel_path,
    width: r.width,
    height: r.height,
    format: r.format,
    camera: r.camera,
    tags: tagged ? new Map(tags) : null,
    comicRoot: !!r.comic_root,
  });
  const score = tagged ? artScore({ w: r.width, h: r.height, fileName: r.file_name }, tags) : null;
  return { kind: c.kind, source: c.source, evidence: c.evidence, theme: tagged ? classifyTheme(tags, score) : null, artScore: score };
}

export function classificationStatements(db: Db): { auto: Statement; manual: Statement } {
  return {
    auto: db.prepare(`UPDATE images SET content_kind = @kind, content_kind_source = @source, content_kind_evidence = @evidence,
      content_kind_version = @version, theme = @theme, art_score = @artScore WHERE id = @id AND content_kind_manual = 0`),
    manual: db.prepare(`UPDATE images SET content_kind_version = @version, theme = @theme, art_score = @artScore
      WHERE id = @id AND content_kind_manual = 1`),
  };
}

export function writeClassification(stmts: { auto: Statement; manual: Statement }, r: ClassRow, c: Classification): void {
  const p = { id: r.id, version: CLASSIFIER_VERSION, theme: c.theme, artScore: c.artScore };
  if (r.content_kind_manual) stmts.manual.run(p);
  else stmts.auto.run({ ...p, kind: c.kind, source: c.source, evidence: c.evidence });
}

/**
 * 分类标签：Map<imageId, [名字, 分数][]>（只含 CLASSIFY_TAG_NAMES）。
 * 先把名字换成 tag_id 再查（按名字 JOIN 慢 6 倍）；ids = 'all' 时一次走 idx_image_tags_tag_score 读全库，给启动回填用。
 */
export function loadClassifyTags(db: Db, ids: number[] | 'all'): Map<number, [string, number][]> {
  const out = new Map<number, [string, number][]>();
  if (ids !== 'all' && !ids.length) return out;
  const tagRows = db
    .prepare('SELECT id, name FROM tags WHERE name IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(CLASSIFY_TAG_NAMES)) as { id: number; name: string }[];
  if (!tagRows.length) return out;
  const nameOf = new Map(tagRows.map((t) => [t.id, t.name]));
  const tagIds = JSON.stringify(tagRows.map((t) => t.id));
  const rows = (
    ids === 'all'
      ? db.prepare('SELECT image_id AS iid, tag_id AS tid, score FROM image_tags WHERE tag_id IN (SELECT value FROM json_each(?))').all(tagIds)
      : db
          .prepare(
            `SELECT image_id AS iid, tag_id AS tid, score FROM image_tags
             WHERE image_id IN (SELECT value FROM json_each(@ids)) AND tag_id IN (SELECT value FROM json_each(@tags))`,
          )
          .all({ ids: JSON.stringify(ids), tags: tagIds })
  ) as { iid: number; tid: number; score: number }[];
  for (const x of rows) {
    const r = { iid: x.iid, name: nameOf.get(x.tid)!, score: x.score };
    const list = out.get(r.iid);
    if (list) list.push([r.name, r.score]);
    else out.set(r.iid, [[r.name, r.score]]);
  }
  return out;
}

const BATCH = 2000;

/**
 * 回填：不传 ids 时选版本过期的行（content_kind_version IS NULL 或 < CLASSIFIER_VERSION）；传 ids 时重算这些行。
 * 同步执行，每批一个事务。返回重算的行数和耗时。
 */
export function backfillClassification(db: Db, opts: { ids?: number[] } = {}): { rows: number; ms: number } {
  const t0 = performance.now();
  const rows = (
    opts.ids
      ? db.prepare(`SELECT ${CLASS_COLS} FROM images WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(opts.ids))
      : db
          .prepare(`SELECT ${CLASS_COLS} FROM images WHERE content_kind_version IS NULL OR content_kind_version < ?`)
          .all(CLASSIFIER_VERSION)
  ) as ClassRow[];
  if (!rows.length) return { rows: 0, ms: 0 };
  const stmts = classificationStatements(db);
  // 行多时一次读全库的分类标签，比按批查快得多
  const everything = rows.length > BATCH ? loadClassifyTags(db, 'all') : null;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const tags =
      everything ??
      loadClassifyTags(
        db,
        batch.filter((r) => r.tagged_at !== null).map((r) => r.id),
      );
    transact(db, () => {
      for (const r of batch) writeClassification(stmts, r, computeClassification(r, r.tagged_at !== null ? (tags.get(r.id) ?? []) : null));
    });
  }
  return { rows: rows.length, ms: Math.round(performance.now() - t0) };
}
