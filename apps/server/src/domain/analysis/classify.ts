/**
 * 分析模块的分类：内容类型（自动）、是否动图（D5）、主题、画质分（T27、T27 补充）。全项目只有分析模块写这几列（单一写入者），
 * 什么时候算由唯一的入口 analyze（analyze.ts）决定，别处不直接调这里。
 *
 * content_kind_manual=1 的行只写是否动图、theme、art_score（manual 只保护类型；是否动图按帧数派生，不是手动选项）；任何重算都不动 shelved_at。
 */
import type { ContentKind, ContentKindSource, ImageFormat } from '@emaki/shared';
import { transact, type Db, type Statement } from '../../db/connection.ts';
import type { ProbeFacts } from '../../propagation/changes.ts';
import { stmt } from '../tx.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { classifyContent, CLASSIFIER_VERSION, isAnimated, SIGNAL_TAGS } from '../../services/classify/rules.ts';
import { artScore, classifyTheme, THEME_TAG_NAMES, type StoredTheme } from '../../services/classify/theme.ts';

export interface ClassRow {
  id: number;
  file_name: string;
  rel_path: string;
  width: number;
  height: number;
  format: ImageFormat;
  frame_count?: number | null;
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
  /** 是动图（D5，和类型无关） */
  animated: boolean;
  theme: StoredTheme | null;
  artScore: number | null;
}

/** 只能接在 FROM images 后面（不带别名）：comic_root = 在按漫画导入的范围里（comicAreas.ts） */
export const CLASS_COLS = `id, file_name, rel_path, width, height, format, frame_count, camera, content_kind_manual, tagged_at,
  ${IN_COMIC('images')} AS comic_root`;
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
  return {
    kind: c.kind,
    source: c.source,
    evidence: c.evidence,
    animated: isAnimated({ format: r.format, frames: r.frame_count }),
    theme: tagged ? classifyTheme(tags, score) : null,
    artScore: score,
  };
}

interface ClassStatements {
  auto: Statement;
  manual: Statement;
  /** 同时写读文件头拿到的帧数、相机（入库、文件内容变了：一条 UPDATE 写完，不另外写这两列） */
  autoProbed: Statement;
  manualProbed: Statement;
}

function classificationStatements(db: Db): ClassStatements {
  return {
    auto: stmt(
      db,
      `UPDATE images SET content_kind = @kind, content_kind_source = @source, content_kind_evidence = @evidence, animated = @animated,
         content_kind_version = @version, theme = @theme, art_score = @artScore WHERE id = @id AND content_kind_manual = 0`,
    ),
    manual: stmt(
      db,
      `UPDATE images SET animated = @animated, content_kind_version = @version, theme = @theme, art_score = @artScore
       WHERE id = @id AND content_kind_manual = 1`,
    ),
    autoProbed: stmt(
      db,
      `UPDATE images SET frame_count = @frames, camera = @camera, content_kind = @kind, content_kind_source = @source,
         content_kind_evidence = @evidence, animated = @animated, content_kind_version = @version, theme = @theme, art_score = @artScore
       WHERE id = @id AND content_kind_manual = 0`,
    ),
    manualProbed: stmt(
      db,
      `UPDATE images SET frame_count = @frames, camera = @camera, animated = @animated, content_kind_version = @version, theme = @theme,
         art_score = @artScore WHERE id = @id AND content_kind_manual = 1`,
    ),
  };
}

function writeClassification(stmts: ClassStatements, r: ClassRow, c: Classification, probed: boolean): void {
  const p = { id: r.id, version: CLASSIFIER_VERSION, animated: c.animated ? 1 : 0, theme: c.theme, artScore: c.artScore };
  const q = probed ? { ...p, frames: r.frame_count ?? null, camera: r.camera } : p;
  if (r.content_kind_manual) (probed ? stmts.manualProbed : stmts.manual).run(q);
  else (probed ? stmts.autoProbed : stmts.auto).run({ ...q, kind: c.kind, source: c.source, evidence: c.evidence });
}

/**
 * 分类标签：Map<imageId, [名字, 分数][]>（只含 CLASSIFY_TAG_NAMES）。
 * 先把名字换成 tag_id 再查（按名字 JOIN 慢 6 倍）；ids = 'all' 时一次走 idx_image_tags_tag_score 读全库，给启动回填用。
 */
export function loadClassifyTags(db: Db, ids: number[] | 'all'): Map<number, [string, number][]> {
  const out = new Map<number, [string, number][]>();
  if (ids !== 'all' && !ids.length) return out;
  const tagRows = stmt(db, 'SELECT id, name FROM tags WHERE name IN (SELECT value FROM json_each(?))').all(JSON.stringify(CLASSIFY_TAG_NAMES)) as {
    id: number;
    name: string;
  }[];
  if (!tagRows.length) return out;
  const nameOf = new Map(tagRows.map((t) => [t.id, t.name]));
  const tagIds = JSON.stringify(tagRows.map((t) => t.id));
  const rows = (
    ids === 'all'
      ? db.prepare('SELECT image_id AS iid, tag_id AS tid, score FROM image_tags WHERE tag_id IN (SELECT value FROM json_each(?))').all(tagIds)
      : stmt(
          db,
          `SELECT image_id AS iid, tag_id AS tid, score FROM image_tags
           WHERE image_id IN (SELECT value FROM json_each(@ids)) AND tag_id IN (SELECT value FROM json_each(@tags))`,
        ).all({ ids: JSON.stringify(ids), tags: tagIds })
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
 * 重算：不传 ids 时选版本过期的行（content_kind_version IS NULL 或 < CLASSIFIER_VERSION）；传 ids 时重算这些行。
 * probes：读文件头拿到的帧数、相机（只给了一项的另一项不动），先换进去再判，和类型一起写（同一条 UPDATE）。
 * tags：调用方手上已经有的识别标签（识别写入刚写完的），这些图不再读库。
 * 同步执行，每批一个事务（在外层事务里就是保存点）。返回重算的行数和耗时。
 */
export function backfillClassification(
  db: Db,
  opts: { ids?: number[]; probes?: ReadonlyMap<number, ProbeFacts>; tags?: ReadonlyMap<number, [string, number][]> } = {},
): { rows: number; ms: number } {
  const t0 = performance.now();
  const rows = (
    opts.ids
      ? stmt(db, `SELECT ${CLASS_COLS} FROM images WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(opts.ids))
      : db
          .prepare(`SELECT ${CLASS_COLS} FROM images WHERE content_kind_version IS NULL OR content_kind_version < ?`)
          .all(CLASSIFIER_VERSION)
  ) as ClassRow[];
  if (!rows.length) return { rows: 0, ms: 0 };
  const probes = opts.probes;
  if (probes)
    for (const r of rows) {
      const p = probes.get(r.id);
      if (!p) continue;
      if (p.frames !== undefined) r.frame_count = p.frames;
      if (p.camera !== undefined) r.camera = p.camera;
    }
  const stmts = classificationStatements(db);
  // 行多时一次读全库的分类标签，比按批查快得多
  const everything = rows.length > BATCH ? loadClassifyTags(db, 'all') : null;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // 调用方手上已经有的标签（刚识别完的）不再读库
    const given = opts.tags;
    const tags =
      everything ??
      loadClassifyTags(
        db,
        batch.filter((r) => r.tagged_at !== null && !given?.has(r.id)).map((r) => r.id),
      );
    transact(db, () => {
      for (const r of batch) {
        const c = computeClassification(r, r.tagged_at !== null ? (given?.get(r.id) ?? tags.get(r.id) ?? []) : null);
        writeClassification(stmts, r, c, !!probes?.has(r.id));
      }
    });
  }
  return { rows: rows.length, ms: Math.round(performance.now() - t0) };
}
