/**
 * PoseWear 姿势库（实验）：姿势目录和每张图的匹配。posewear_poses、image_posewear、image_posewear_candidates 只在这里写
 * （test/architecture/owners.ts）；写入在调用方的事务（ctx.apply）里，写完由调用方声明 pose.changed。
 * 线稿图片在 <数据目录>/pose/posewear/{t,i}/（services/pose/posewear.ts 复制），这里只管表。
 * 张数按口径（计入统计的插画，和 51 类一样）现算。
 */
import {
  POSEWEAR_SET_LABEL,
  POSEWEAR_SETS,
  type PoseWearCatalogResponse,
  type PoseWearMatch,
  type PoseWearOfResponse,
  type PoseWearPose,
  type PoseWearSet,
} from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { parseId } from '../../datasource/sqlite/sql.ts';
import { POSE_ELIGIBLE } from './read.ts';

export interface PoseWearPoseRow {
  id: string;
  set: PoseWearSet;
  number: string;
  name: string;
  category: string;
  sort: number;
  views: string[];
  bestView: string;
}

export interface PoseWearAssignRow {
  imageId: number;
  poseId: string;
  distance: number | null;
  tagScore: number | null;
  method: string;
  rank: number;
  view: string | null;
  candidates: { poseId: string; accepted: boolean; distance: number | null; tagScore: number | null; method: string | null }[];
}

// ------------------------------------------------------------------ 写

/** 写姿势目录（整批替换：这次没有的姿势删掉，它们的匹配跟着删）；返回新版本号 */
export function writePoseWearPoses(db: Db, rows: readonly PoseWearPoseRow[]): number {
  const version = ((db.prepare('SELECT MAX(version) FROM posewear_poses').pluck().get() as number | null) ?? 0) + 1;
  const st = db.prepare(
    `INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, version)
     VALUES (@id, @set, @number, @name, @category, @sort, @views, @bestView, @version)
     ON CONFLICT(id) DO UPDATE SET set_id = excluded.set_id, number = excluded.number, name = excluded.name, category = excluded.category,
       sort = excluded.sort, views = excluded.views, best_view = excluded.best_view, version = excluded.version`,
  );
  for (const r of rows) st.run({ ...r, views: JSON.stringify(r.views), version });
  db.prepare('DELETE FROM posewear_poses WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((r) => r.id)));
  return version;
}

/** 换掉全部匹配（匹配结果是整批算出来的，再导一次结果不变）；返回之前有匹配的图 */
export function replacePoseWearAssignments(db: Db, rows: readonly PoseWearAssignRow[], now: string): number[] {
  const before = db.prepare('SELECT image_id FROM image_posewear').pluck().all() as number[];
  db.prepare('DELETE FROM image_posewear_candidates').run();
  db.prepare('DELETE FROM image_posewear').run();
  const main = db.prepare(
    `INSERT INTO image_posewear (image_id, pose_id, distance, tag_score, method, rank, view, updated_at)
     VALUES (@imageId, @poseId, @distance, @tagScore, @method, @rank, @view, @now)`,
  );
  const cand = db.prepare(
    `INSERT INTO image_posewear_candidates (image_id, ord, pose_id, accepted, distance, tag_score, method)
     VALUES (@imageId, @ord, @poseId, @accepted, @distance, @tagScore, @method)`,
  );
  for (const r of rows) {
    main.run({ imageId: r.imageId, poseId: r.poseId, distance: r.distance, tagScore: r.tagScore, method: r.method, rank: r.rank, view: r.view, now });
    r.candidates.forEach((c, ord) => cand.run({ imageId: r.imageId, ord, poseId: c.poseId, accepted: c.accepted ? 1 : 0, distance: c.distance, tagScore: c.tagScore, method: c.method }));
  }
  return before;
}

// ------------------------------------------------------------------ 读

/** 线稿地址：t 小图、i 大图；带版本，重导后浏览器重新取 */
export const posewearFileUrl = (size: 't' | 'i', id: string, view: string, version: number) => `/api/pose/posewear/${size}/${id}_${view}.webp?v=${version}`;

interface PoseDbRow {
  id: string;
  set_id: PoseWearSet;
  number: string;
  name: string;
  category: string;
  sort: number;
  best_view: string;
  version: number;
  n: number;
}

const COUNT_SQL = `(SELECT COUNT(*) FROM image_posewear a JOIN images i ON i.id = a.image_id JOIN library_roots r ON r.id = i.root_id
  WHERE a.pose_id = p.id AND ${POSE_ELIGIBLE})`;

function toPose(r: PoseDbRow): PoseWearPose {
  return {
    id: r.id,
    set: r.set_id,
    number: r.number,
    name: r.name,
    category: r.category,
    count: r.n,
    thumbUrl: posewearFileUrl('t', r.id, r.best_view, r.version),
    imageUrl: posewearFileUrl('i', r.id, r.best_view, r.version),
  };
}

/** 姿势目录：按套（固定顺序）、分类（PoseWear 里的顺序）分组；默认只给有图的姿势 */
export function posewearCatalog(db: Db, all = false): PoseWearCatalogResponse {
  const rows = db.prepare(`SELECT p.*, ${COUNT_SQL} AS n FROM posewear_poses p ORDER BY p.sort`).all() as PoseDbRow[];
  const sets = POSEWEAR_SETS.map((id) => {
    const cats = new Map<string, PoseWearPose[]>();
    for (const r of rows) {
      if (r.set_id !== id || (!all && r.n === 0)) continue;
      const list = cats.get(r.category) ?? [];
      list.push(toPose(r));
      cats.set(r.category, list);
    }
    const categories = [...cats].map(([name, poses]) => ({ name, count: poses.reduce((s, p) => s + p.count, 0), poses }));
    return { id, name: POSEWEAR_SET_LABEL[id], count: categories.reduce((s, c) => s + c.count, 0), categories };
  }).filter((s) => s.categories.length > 0);
  return { sets, poses: rows.length };
}

/** 一张图匹配到的姿势：主要的一个 + 过了阈值的其他候选（最多 2 个） */
export function posewearOf(db: Db, imageId: string): PoseWearOfResponse {
  const id = parseId(imageId);
  const empty = { imageId, primary: null, related: [] };
  if (id === null) return empty;
  const main = db.prepare('SELECT pose_id, distance, tag_score, method, rank, view FROM image_posewear WHERE image_id = ?').get(id) as
    | { pose_id: string; distance: number | null; tag_score: number | null; method: string; rank: number; view: string | null }
    | undefined;
  if (!main) return empty;
  const cands = db
    .prepare('SELECT pose_id, distance, tag_score, method FROM image_posewear_candidates WHERE image_id = ? AND accepted = 1 AND pose_id <> ? ORDER BY ord LIMIT 2')
    .all(id, main.pose_id) as { pose_id: string; distance: number | null; tag_score: number | null; method: string | null }[];
  const ids = [main.pose_id, ...cands.map((c) => c.pose_id)];
  const poses = db
    .prepare(`SELECT p.*, ${COUNT_SQL} AS n FROM posewear_poses p WHERE p.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as (PoseDbRow & { views: string })[];
  const byId = new Map(poses.map((p) => [p.id, p]));
  const match = (poseId: string, distance: number | null, tagScore: number | null, method: string | null, view: string | null): PoseWearMatch | null => {
    const p = byId.get(poseId);
    if (!p) return null;
    const v = view && (JSON.parse(p.views) as string[]).includes(view) ? view : p.best_view;
    return { pose: toPose(p), distance, tagScore, method, viewThumbUrl: posewearFileUrl('t', p.id, v, p.version) };
  };
  const primary = match(main.pose_id, main.distance, main.tag_score, main.method, main.view);
  return {
    imageId,
    primary: primary ? { ...primary, rank: main.rank } : null,
    related: cands.flatMap((c) => match(c.pose_id, c.distance, c.tag_score, c.method, null) ?? []),
  };
}

/** 状态里的两个数：导入了多少姿势、多少张（计入统计的插画）有主要匹配 */
export function posewearCounts(db: Db): { poses: number; assigned: number } {
  const poses = db.prepare('SELECT COUNT(*) FROM posewear_poses').pluck().get() as number;
  const assigned = db
    .prepare(`SELECT COUNT(*) FROM image_posewear a JOIN images i ON i.id = a.image_id JOIN library_roots r ON r.id = i.root_id WHERE ${POSE_ELIGIBLE}`)
    .pluck()
    .get() as number;
  return { poses, assigned };
}

/** 已导入的姿势 id */
export function posewearPoseIds(db: Db): Set<string> {
  return new Set(db.prepare('SELECT id FROM posewear_poses').pluck().all() as string[]);
}
