/**
 * 姿势标签的低分（证据模块的表 image_pose_tags_low、image_pose_tags_checked，迁移 049）：
 * 识别模型对姿势名单（poseTagList.ts）里的标签给出的分数，在 [POSE_LOW_MIN, 一般标签阈值) 的记在这里；
 * 达到阈值的照旧在 image_tags（显示、筛选、自动决定都只看那边），这里只给按姿势找图用。
 * 按「图片」整体替换：正常识别（TagResultWriter）、「补充姿势标签」任务、导入原型的 npz 都经 writePoseTagsLow 写。
 * 没有反应订阅这份证据，所以不声明变化。
 */
import type { Db } from '../../db/connection.ts';
import { COUNTED, ILLUSTRATION } from '../../readmodel/terms.ts';
import { stmt } from '../tx.ts';
import { POSE_LOW_MIN, POSE_TAGS } from './poseTagList.ts';

export { POSE_LOW_MIN, POSE_TAGS, POSE_TAGS_VERSION } from './poseTagList.ts';

const LISTED = new Set(POSE_TAGS);

export interface PoseLowRow {
  imageId: number;
  /** 给出这些分数的识别模型（images.tagger_model 的写法） */
  model: string;
  /** 模型给的 [标签, 分数]；不在名单里、不在范围里的写的时候丢掉 */
  low: readonly (readonly [string, number])[];
}

/** 只留名单里、分数在 [POSE_LOW_MIN, max) 的；同名的留分数高的 */
export function keepPoseLow(low: readonly (readonly [string, number])[], max: number): [string, number][] {
  const best = new Map<string, number>();
  for (const [name, score] of low) {
    if (!LISTED.has(name) || !(score >= POSE_LOW_MIN) || !(score < max)) continue;
    if (score > (best.get(name) ?? -1)) best.set(name, score);
  }
  return [...best].sort((a, b) => b[1] - a[1]);
}

/**
 * 写一批图的低分姿势标签（替换旧的），并记下这张图收集过（用哪个模型）；low 为空的图只记收集过。
 * max 是这次识别的一般标签阈值（达到它的在 image_tags 里）。必须在事务里调用；返回写了几条
 */
export function writePoseTagsLow(db: Db, rows: readonly PoseLowRow[], max: number, at: string): number {
  const upsertTag = stmt(db, "INSERT INTO tags (name, category) VALUES (?, 'general') ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id");
  const del = stmt(db, 'DELETE FROM image_pose_tags_low WHERE image_id = ?');
  const ins = stmt(db, 'INSERT INTO image_pose_tags_low (image_id, tag_id, score) VALUES (?, ?, ?)');
  const mark = stmt(
    db,
    `INSERT INTO image_pose_tags_checked (image_id, model, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(image_id) DO UPDATE SET model = excluded.model, checked_at = excluded.checked_at`,
  );
  const ids = new Map<string, number>();
  const tagId = (name: string) => {
    let id = ids.get(name);
    if (id === undefined) ids.set(name, (id = (upsertTag.get(name) as { id: number }).id));
    return id;
  };
  let n = 0;
  for (const r of rows) {
    del.run(r.imageId);
    for (const [name, score] of keepPoseLow(r.low, max)) {
      ins.run(r.imageId, tagId(name), Math.round(score * 1e4) / 1e4);
      n++;
    }
    mark.run(r.imageId, r.model, at);
  }
  return n;
}

/** 一张图的低分姿势标签（按分数从高到低） */
export function poseTagsLowOf(db: Db, imageId: number): [string, number][] {
  const rows = stmt(db, 'SELECT t.name, l.score FROM image_pose_tags_low l JOIN tags t ON t.id = l.tag_id WHERE l.image_id = ? ORDER BY l.score DESC, t.name').all(
    imageId,
  ) as { name: string; score: number }[];
  return rows.map((r) => [r.name, r.score]);
}

// ---------------------------------------------------------------- 「补充姿势标签」要跑的图

/**
 * 识别过的、计入统计的插画，还没按它现在的识别模型收集过低分姿势标签（配合 JOIN library_roots r、LEFT JOIN image_pose_tags_checked c）。
 * @defaultModel：images.tagger_model 为空时按哪个模型算（设置里的识别模型）
 */
export const POSE_TAGS_PENDING = `${COUNTED()} AND ${ILLUSTRATION} AND i.tagged_at IS NOT NULL
  AND (c.image_id IS NULL OR c.model IS NOT COALESCE(i.tagger_model, @defaultModel))`;
export const POSE_TAGS_FROM = `FROM images i JOIN library_roots r ON r.id = i.root_id LEFT JOIN image_pose_tags_checked c ON c.image_id = i.id`;

/** 要补的图按识别模型分组（模型 = images.tagger_model，空的按 defaultModel） */
export function poseTagsPendingByModel(db: Db, defaultModel: string): { model: string; n: number }[] {
  return stmt(
    db,
    `SELECT COALESCE(i.tagger_model, @defaultModel) AS model, COUNT(*) AS n ${POSE_TAGS_FROM} WHERE ${POSE_TAGS_PENDING} GROUP BY 1 ORDER BY 2 DESC`,
  ).all({ defaultModel }) as { model: string; n: number }[];
}

export interface PoseTagsCounts {
  /** 识别过的、计入统计的插画 */
  eligible: number;
  /** 其中还没按现在的识别模型收集过低分姿势标签的 */
  pending: number;
  /** 低分姿势标签的条数、有低分姿势标签的图（全部行） */
  lowTags: number;
  images: number;
}

export function poseTagsCounts(db: Db, defaultModel: string): PoseTagsCounts {
  const r = stmt(
    db,
    `SELECT COUNT(*) AS eligible,
       SUM(CASE WHEN c.image_id IS NULL OR c.model IS NOT COALESCE(i.tagger_model, @defaultModel) THEN 1 ELSE 0 END) AS pending
     ${POSE_TAGS_FROM} WHERE ${COUNTED()} AND ${ILLUSTRATION} AND i.tagged_at IS NOT NULL`,
  ).get({ defaultModel }) as { eligible: number; pending: number | null };
  const low = stmt(db, 'SELECT COUNT(*) AS n, COUNT(DISTINCT image_id) AS images FROM image_pose_tags_low').get() as { n: number; images: number };
  return { eligible: r.eligible, pending: r.pending ?? 0, lowTags: low.n, images: low.images };
}
