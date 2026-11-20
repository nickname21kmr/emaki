/**
 * 姿势的读模型：类别列表（每组、每类计入统计的张数）、状态里的计数、「姿势相近的图」、归类用的代表骨架。
 * 张数按口径（readmodel/terms.ts 的 COUNTED、ILLUSTRATION）现算，不用 pose_classes.size（那是全部行）。
 */
import type { PoseClassesResponse, PoseGroup, PoseSimilarResponse, PoseStatus } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from '../../datasource/sqlite/hydrate.ts';
import { decodeCursor, encodeCursor, parseId } from '../../datasource/sqlite/sql.ts';
import { COUNTED, ILLUSTRATION } from '../../readmodel/terms.ts';
import { loadPoseAsset } from './asset.ts';
import { poseDistance, poseFeatures, unpackMedoid, unpackPerson, type ClassRef } from './features.ts';
import { POSE_VERSION } from './store.ts';

/** 示意小人的地址：带上类别版本，换了类别浏览器重新取 */
export const figureUrl = (id: string, version: number) => `/api/pose/classes/${id}/figure.png?v=${version}`;

/** 要提取姿势的图：计入统计的插画 */
export const POSE_ELIGIBLE = `${COUNTED('i', 'r')} AND ${ILLUSTRATION}`;
/** 还没按当前版本提取过的（配合 LEFT JOIN image_poses p） */
export const POSE_PENDING = `(p.image_id IS NULL OR p.version < ${POSE_VERSION})`;

export function poseClasses(db: Db): PoseClassesResponse {
  const rows = db
    .prepare(
      `SELECT c.id, c.grp, c.name, c.description, c.version,
         (SELECT COUNT(*) FROM image_poses p JOIN images i ON i.id = p.image_id JOIN library_roots r ON r.id = i.root_id
           WHERE p.class_id = c.id AND ${POSE_ELIGIBLE}) AS n
       FROM pose_classes c ORDER BY c.sort`,
    )
    .all() as { id: string; grp: PoseGroup; name: string; description: string; version: number; n: number }[];
  const asset = loadPoseAsset();
  return {
    groups: asset.groups.map((g) => {
      const classes = rows
        .filter((r) => r.grp === g.id)
        .map((r) => ({ id: r.id, group: r.grp, name: r.name, description: r.description, count: r.n, figureUrl: figureUrl(r.id, r.version) }));
      return { id: g.id as PoseGroup, name: g.name, count: classes.reduce((s, c) => s + c.count, 0), classes };
    }),
  };
}

export function poseFigure(db: Db, id: string): Buffer | null {
  const r = db.prepare('SELECT figure FROM pose_classes WHERE id = ?').get(id) as { figure: Buffer } | undefined;
  return r?.figure ?? null;
}

export function poseCounts(db: Db): PoseStatus['counts'] {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS eligible,
         SUM(CASE WHEN p.image_id IS NOT NULL AND p.version >= ${POSE_VERSION} THEN 1 ELSE 0 END) AS processed,
         SUM(CASE WHEN p.keypoints IS NOT NULL AND p.version >= ${POSE_VERSION} THEN 1 ELSE 0 END) AS withPerson,
         SUM(CASE WHEN p.class_id IS NOT NULL AND p.version >= ${POSE_VERSION} THEN 1 ELSE 0 END) AS classified
       FROM images i JOIN library_roots r ON r.id = i.root_id LEFT JOIN image_poses p ON p.image_id = i.id
       WHERE ${POSE_ELIGIBLE}`,
    )
    .get() as { eligible: number; processed: number | null; withPerson: number | null; classified: number | null };
  const processed = r.processed ?? 0;
  return { eligible: r.eligible, processed, pending: r.eligible - processed, withPerson: r.withPerson ?? 0, classified: r.classified ?? 0 };
}

export function posePendingCount(db: Db): number {
  return db
    .prepare(`SELECT COUNT(*) FROM images i JOIN library_roots r ON r.id = i.root_id LEFT JOIN image_poses p ON p.image_id = i.id WHERE ${POSE_ELIGIBLE} AND ${POSE_PENDING}`)
    .pluck()
    .get() as number;
}

/** 归类用的代表骨架（从库里读：类别已经按版本同步进来） */
export function classRefsFromDb(db: Db): ClassRef[] {
  const rows = db.prepare('SELECT id, grp, cut, medoid FROM pose_classes ORDER BY sort').all() as { id: string; grp: string; cut: number; medoid: Buffer }[];
  return rows.map((r) => {
    const m = unpackMedoid(r.medoid);
    return { id: r.id, group: r.grp, cut: r.cut, features: poseFeatures(m.kp, m.ks) };
  });
}

const isOffset = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/**
 * 和这张图姿势相近的图：同一类（这张图没归类时用最近的那一类）里、计入统计的插画，按和这张图主要人物的骨架距离排（镜像不变）。
 * 一类最多两千来张，每次现算距离（几毫秒）
 */
export function similarPoses(db: Db, imageId: string, cursor?: string, limit = 60): PoseSimilarResponse {
  const id = parseId(imageId);
  const src = id === null ? undefined : (db.prepare('SELECT status, grp, keypoints, class_id, nearest_id FROM image_poses WHERE image_id = ?').get(id) as
    | { status: string; grp: PoseGroup | null; keypoints: Buffer | null; class_id: string | null; nearest_id: string | null }
    | undefined);
  const cls = src?.class_id ?? src?.nearest_id ?? null;
  const source = { imageId, classId: src?.class_id ?? null, group: src?.grp ?? null, status: src?.status ?? null };
  if (!src?.keypoints || !cls) return { source, items: [], total: 0, nextCursor: null };
  const me = unpackPerson(src.keypoints).person;
  const mine = poseFeatures(me.kp, me.ks);
  const cands = db
    .prepare(
      `SELECT p.image_id AS id, p.keypoints FROM image_poses p JOIN images i ON i.id = p.image_id JOIN library_roots r ON r.id = i.root_id
       WHERE p.class_id = ? AND p.keypoints IS NOT NULL AND p.image_id <> ? AND ${POSE_ELIGIBLE}`,
    )
    .all(cls, id) as { id: number; keypoints: Buffer }[];
  const ranked = cands
    .map((c) => {
      const p = unpackPerson(c.keypoints).person;
      return { id: c.id, ...poseDistance(poseFeatures(p.kp, p.ks), mine) };
    })
    .sort((a, b) => a.d - b.d || a.id - b.id);
  const off = decodeCursor(cursor, isOffset) ?? 0;
  const lim = Math.min(Math.max(limit, 1), 200);
  const page = ranked.slice(off, off + lim);
  const rows = page.length
    ? (db.prepare(`SELECT ${IMAGE_COLS} FROM images i WHERE i.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(page.map((p) => p.id))) as ImageRow[])
    : [];
  const items = hydrateImages(db, rows);
  const byId = new Map(items.map((it) => [it.id, it]));
  return {
    source,
    items: page.flatMap((p) => {
      const image = byId.get(String(p.id));
      return image ? [{ image, distance: Math.round(p.d * 10000) / 10000, mirror: p.mirror }] : [];
    }),
    total: ranked.length,
    nextCursor: off + lim < ranked.length ? encodeCursor(off + lim) : null,
  };
}
