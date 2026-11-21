/**
 * PoseWear 姿势库（实验）：姿势目录和每张图的匹配。posewear_poses、image_posewear_members 只在这里写
 * （test/architecture/owners.ts）；写入在调用方的事务（ctx.apply）里，写完由调用方声明 pose.changed。
 * 线稿图片在 <数据目录>/pose/posewear/{t,i}/（services/pose/posewear.ts 复制），这里只管表。
 * 一张图在每个匹配上的姿势下都有一行（迁移 043）；低置信 = lowtag+skel。双人的差分（variant_of）不单独出现。
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
  adult: boolean;
}

/** 一个（图, 姿势） */
export interface PoseWearMemberRow {
  imageId: number;
  poseId: string;
  /** 名次：照原型给的用，不再按方法重排 */
  rank: number;
  /** 原型的加权分（0.6·骨架相似 + 0.4·标签分），旧格式和双人没有 */
  score?: number | null;
  primary: boolean;
  method: string;
  distance: number | null;
  tagScore: number | null;
  view: string | null;
  /** 双人：同一组差分里最像那张的 id */
  variantOf?: number | null;
}

/** 低置信的方法：标签弱、主要靠骨架 */
export const LOW_METHOD = 'lowtag+skel';

/** 单人 / 双人：两份匹配结果分开导入，各换各的 */
export type MemberScope = 'single' | 'pair';
const SCOPE_SQL: Record<MemberScope, string> = {
  single: "pose_id IN (SELECT id FROM posewear_poses WHERE set_id <> 'pair')",
  pair: "pose_id IN (SELECT id FROM posewear_poses WHERE set_id = 'pair')",
};

// ------------------------------------------------------------------ 写

/** 写姿势目录（整批替换：这次没有的姿势删掉，它们的匹配跟着删）；返回新版本号 */
export function writePoseWearPoses(db: Db, rows: readonly PoseWearPoseRow[]): number {
  const version = ((db.prepare('SELECT MAX(version) FROM posewear_poses').pluck().get() as number | null) ?? 0) + 1;
  const st = db.prepare(
    `INSERT INTO posewear_poses (id, set_id, number, name, category, sort, views, best_view, adult, version)
     VALUES (@id, @set, @number, @name, @category, @sort, @views, @bestView, @adult, @version)
     ON CONFLICT(id) DO UPDATE SET set_id = excluded.set_id, number = excluded.number, name = excluded.name, category = excluded.category,
       sort = excluded.sort, views = excluded.views, best_view = excluded.best_view, adult = excluded.adult, version = excluded.version`,
  );
  for (const r of rows) st.run({ ...r, views: JSON.stringify(r.views), adult: r.adult ? 1 : 0, version });
  db.prepare('DELETE FROM posewear_poses WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(rows.map((r) => r.id)));
  return version;
}

/** 换掉单人或双人的全部匹配（匹配结果是整批算出来的，再导一次结果不变）；返回之前有这一边匹配的图 */
export function replacePoseWearMembers(db: Db, scope: MemberScope, rows: readonly PoseWearMemberRow[], now: string): number[] {
  const before = db.prepare(`SELECT DISTINCT image_id FROM image_posewear_members WHERE ${SCOPE_SQL[scope]}`).pluck().all() as number[];
  db.prepare(`DELETE FROM image_posewear_members WHERE ${SCOPE_SQL[scope]}`).run();
  const st = db.prepare(
    `INSERT INTO image_posewear_members (image_id, pose_id, rank, score, is_primary, method, low, distance, tag_score, view, variant_of, updated_at)
     VALUES (@imageId, @poseId, @rank, @score, @primary, @method, @low, @distance, @tagScore, @view, @variantOf, @now)`,
  );
  for (const r of rows)
    st.run({ ...r, score: r.score ?? null, primary: r.primary ? 1 : 0, low: r.method === LOW_METHOD ? 1 : 0, variantOf: r.variantOf ?? null, now });
  return before;
}

/** dHash（16 位 hex）的汉明距离 */
function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** 差分算「几乎一样」的 dHash 距离（64 位里差几位） */
export const VARIANT_DHASH = 10;

/**
 * 双人去差分：同一个姿势里按名次走，和前面留下的某张同一本合集、查重同一组、或 dHash 很近，就记成那张的差分。
 * 只读 images、duplicate_members（查重模块的表），不写。rows 原样返回，variantOf 填好。
 */
export function markPairVariants(db: Db, rows: readonly PoseWearMemberRow[]): PoseWearMemberRow[] {
  const ids = [...new Set(rows.map((r) => r.imageId))];
  const info = new Map<number, { col: number | null; dhash: string | null; dups: number[] }>();
  const img = db.prepare('SELECT id, collection_id AS col, dhash FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as {
    id: number;
    col: number | null;
    dhash: string | null;
  }[];
  for (const r of img) info.set(r.id, { col: r.col, dhash: r.dhash && /^[0-9a-f]{16}$/i.test(r.dhash) ? r.dhash : null, dups: [] });
  const dm = db
    .prepare(
      `SELECT m.image_id, m.group_id FROM duplicate_members m JOIN duplicate_groups g ON g.id = m.group_id
       WHERE g.ignored = 0 AND m.image_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { image_id: number; group_id: number }[];
  for (const r of dm) info.get(r.image_id)?.dups.push(r.group_id);

  const byPose = new Map<string, PoseWearMemberRow[]>();
  for (const r of rows) byPose.set(r.poseId, [...(byPose.get(r.poseId) ?? []), r]);
  const out: PoseWearMemberRow[] = [];
  for (const list of byPose.values()) {
    const kept: { id: number; col: number | null; dhash: string | null; dups: number[] }[] = [];
    for (const r of [...list].sort((a, b) => a.rank - b.rank || a.imageId - b.imageId)) {
      const me = info.get(r.imageId) ?? { col: null, dhash: null, dups: [] };
      const same = kept.find(
        (k) =>
          (me.col !== null && k.col === me.col) ||
          me.dups.some((g) => k.dups.includes(g)) ||
          (me.dhash !== null && k.dhash !== null && hamming(me.dhash, k.dhash) <= VARIANT_DHASH),
      );
      if (same) out.push({ ...r, variantOf: same.id });
      else {
        kept.push({ id: r.imageId, ...me });
        out.push({ ...r, variantOf: null });
      }
    }
  }
  return out;
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
  views: string;
  best_view: string;
  adult: number;
  version: number;
  n: number;
  nlow: number;
}

const ELIGIBLE_JOIN = 'JOIN images i ON i.id = a.image_id JOIN library_roots r ON r.id = i.root_id';
const COUNT_SQL = `(SELECT COUNT(*) FROM image_posewear_members a ${ELIGIBLE_JOIN}
  WHERE a.pose_id = p.id AND a.variant_of IS NULL AND ${POSE_ELIGIBLE})`;
const LOW_SQL = `(SELECT COUNT(*) FROM image_posewear_members a ${ELIGIBLE_JOIN}
  WHERE a.pose_id = p.id AND a.variant_of IS NULL AND a.low = 1 AND ${POSE_ELIGIBLE})`;
const POSE_COLS = `p.*, ${COUNT_SQL} AS n, ${LOW_SQL} AS nlow`;

function toPose(r: PoseDbRow): PoseWearPose {
  return {
    id: r.id,
    set: r.set_id,
    number: r.number,
    name: r.name,
    category: r.category,
    count: r.n,
    low: r.nlow,
    adult: r.adult === 1,
    thumbUrl: posewearFileUrl('t', r.id, r.best_view, r.version),
    imageUrl: posewearFileUrl('i', r.id, r.best_view, r.version),
  };
}

/** 姿势目录：按套（固定顺序，双人在最后）、分类（PoseWear 里的顺序）分组；默认只给有图的姿势 */
export function posewearCatalog(db: Db, all = false): PoseWearCatalogResponse {
  const rows = db.prepare(`SELECT ${POSE_COLS} FROM posewear_poses p ORDER BY p.sort`).all() as PoseDbRow[];
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

/**
 * 一张图匹配到的姿势：主要的一个（单人的主要姿势；没有单人匹配时用双人的）+ 其他全部匹配上的姿势。
 * 其他的排法：单人在前、双人在后，各自主要的在前，再按方法（低置信最后）、距离（这里只是看图器里列的顺序，不影响筛图的名次）。
 */
export function posewearOf(db: Db, imageId: string): PoseWearOfResponse {
  const id = parseId(imageId);
  const empty = { imageId, primary: null, related: [] };
  if (id === null) return empty;
  const rows = db
    .prepare(
      `SELECT ${POSE_COLS}, m.rank AS m_rank, m.is_primary, m.method AS m_method, m.low AS m_low, m.distance AS m_distance, m.tag_score AS m_tag_score, m.view AS m_view
       FROM image_posewear_members m JOIN posewear_poses p ON p.id = m.pose_id
       WHERE m.image_id = ?
       ORDER BY p.set_id = 'pair', m.is_primary DESC, m.low, m.distance IS NULL, m.distance, m.rank`,
    )
    .all(id) as (PoseDbRow & {
    m_rank: number;
    is_primary: number;
    m_method: string;
    m_low: number;
    m_distance: number | null;
    m_tag_score: number | null;
    m_view: string | null;
  })[];
  if (!rows.length) return empty;
  const matches: PoseWearMatch[] = rows.map((r) => {
    const v = r.m_view && (JSON.parse(r.views) as string[]).includes(r.m_view) ? r.m_view : r.best_view;
    return {
      pose: toPose(r),
      distance: r.m_distance,
      tagScore: r.m_tag_score,
      method: r.m_method,
      low: r.m_low === 1,
      rank: r.m_rank,
      viewThumbUrl: posewearFileUrl('t', r.id, v, r.version),
    };
  });
  return { imageId, primary: matches[0]!, related: matches.slice(1) };
}

/** 这个姿势下低置信的图（计入统计的，不含差分） */
export function posewearLowIds(db: Db, poseId: string): string[] {
  return (
    db
      .prepare(`SELECT a.image_id FROM image_posewear_members a ${ELIGIBLE_JOIN} WHERE a.pose_id = ? AND a.low = 1 AND a.variant_of IS NULL AND ${POSE_ELIGIBLE}`)
      .pluck()
      .all(poseId) as number[]
  ).map(String);
}

/** 状态里的数：单人姿势数、有匹配的图、图-姿势对、低置信的对；双人类型数、有匹配的图、去掉差分后的图（都按口径） */
export function posewearCounts(db: Db): {
  poses: number;
  assigned: number;
  pairs: number;
  low: number;
  pair: { types: number; images: number; shown: number };
} {
  const poses = db.prepare("SELECT COUNT(*) FROM posewear_poses WHERE set_id <> 'pair'").pluck().get() as number;
  const types = db.prepare("SELECT COUNT(*) FROM posewear_poses WHERE set_id = 'pair'").pluck().get() as number;
  const c = (pair: boolean) =>
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.image_id) AS images, COUNT(*) AS pairs, COALESCE(SUM(a.low), 0) AS low,
           COUNT(DISTINCT CASE WHEN a.variant_of IS NULL THEN a.image_id END) AS shown
         FROM image_posewear_members a ${ELIGIBLE_JOIN}
         WHERE a.pose_id IN (SELECT id FROM posewear_poses WHERE set_id ${pair ? '=' : '<>'} 'pair') AND ${POSE_ELIGIBLE}`,
      )
      .get() as { images: number; pairs: number; low: number; shown: number };
  const s = c(false);
  const p = c(true);
  return { poses, assigned: s.images, pairs: s.pairs, low: s.low, pair: { types, images: p.images, shown: p.shown } };
}

/** 已导入的姿势 id */
export function posewearPoseIds(db: Db): Set<string> {
  return new Set(db.prepare('SELECT id FROM posewear_poses').pluck().all() as string[]);
}
