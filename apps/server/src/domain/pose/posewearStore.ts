/**
 * PoseWear 匹配的写入（姿势模块：posewear_poses、image_posewear_members、posewear_match_state 只在 domain/pose/ 里写）。
 * 调用方在事务里调用；写完由调用方声明 pose.changed。
 * - 姿势目录从随包的资产同步（syncPoseWearCatalog），不再要 PoseWear 文件夹；
 * - 每张图的匹配按图整体替换（replaceImageMatches），同时记下用的哪一版资产、哪份骨架和标签（posewear_match_state）；
 * - 名次按姿势重排（rerankPoseWear）：单人按名次分，双人骨架过了的在前、只靠标签的在后，再去差分。
 */
import type { Db } from '../../db/connection.ts';
import { stmt } from '../tx.ts';
import { LOW_METHOD, markPairVariants, writePoseWearPoses, type PoseWearMemberRow, type PoseWearPoseRow } from './posewear.ts';
import type { PoseWearHit } from './posewearMatch.ts';
import type { PoseWearAsset } from './posewearAsset.ts';
import { POSE_ELIGIBLE } from './read.ts';

/** 匹配代码的版本：匹配规则（不是资产）改了就加 1，图库会重新匹配一遍 */
export const MATCH_CODE_VERSION = 1;
/** 记在 posewear_match_state.version 里的版本 */
export const matchVersion = (asset: Pick<PoseWearAsset, 'version'>) => asset.version * 100 + MATCH_CODE_VERSION;

/** 资产里的姿势 → posewear_poses 的行 */
export function catalogRows(asset: PoseWearAsset): PoseWearPoseRow[] {
  return asset.poses.map((p) => ({
    id: p.id,
    set: p.set,
    number: p.number,
    name: p.name,
    category: p.category,
    sort: p.sort,
    views: p.views,
    bestView: p.bestView,
    adult: p.adult,
  }));
}

/** 姿势目录和资产对得上就不写（版本号不动，线稿地址不变）；返回有没有写 */
export function syncPoseWearCatalog(db: Db, asset: PoseWearAsset): boolean {
  const want = catalogRows(asset);
  const have = db.prepare('SELECT id, set_id, number, name, category, sort, views, best_view, adult FROM posewear_poses').all() as {
    id: string;
    set_id: string;
    number: string;
    name: string;
    category: string;
    sort: number;
    views: string;
    best_view: string;
    adult: number;
  }[];
  const byId = new Map(have.map((r) => [r.id, r]));
  const same =
    have.length === want.length &&
    want.every((w) => {
      const r = byId.get(w.id);
      return (
        r &&
        r.set_id === w.set &&
        r.number === w.number &&
        r.name === w.name &&
        r.category === w.category &&
        r.sort === w.sort &&
        r.views === JSON.stringify(w.views) &&
        r.best_view === w.bestView &&
        r.adult === (w.adult ? 1 : 0)
      );
    });
  if (same) return false;
  writePoseWearPoses(db, want);
  return true;
}

/** 线稿换了（导入、放进 pose-covers）：版本加 1，浏览器重新取 */
export function bumpPoseWearVersion(db: Db): void {
  db.prepare('UPDATE posewear_poses SET version = (SELECT MAX(version) FROM posewear_poses) + 1').run();
}

export interface MatchState {
  imageId: number;
  poseAt: string | null;
  taggedAt: string | null;
  lowAt: string | null;
}

/**
 * 换掉这些图的全部匹配（单人和双人）：没匹配上的图只删旧的；名次先记 0，调用方随后 rerankPoseWear。返回动到的姿势
 */
export function replaceImageMatches(
  db: Db,
  results: readonly { state: MatchState; hits: readonly PoseWearHit[] }[],
  version: number,
  now: string,
): Set<string> {
  const touched = new Set<string>();
  const old = stmt(db, 'SELECT pose_id FROM image_posewear_members WHERE image_id = ?');
  const del = stmt(db, 'DELETE FROM image_posewear_members WHERE image_id = ?');
  const ins = stmt(
    db,
    `INSERT INTO image_posewear_members (image_id, pose_id, rank, score, is_primary, method, low, distance, tag_score, view, variant_of, updated_at)
     VALUES (@imageId, @poseId, 0, @score, @primary, @method, @low, @distance, @tagScore, @view, NULL, @now)`,
  );
  const state = stmt(
    db,
    `INSERT INTO posewear_match_state (image_id, version, pose_at, tagged_at, low_at, matched_at) VALUES (@imageId, @version, @poseAt, @taggedAt, @lowAt, @now)
     ON CONFLICT(image_id) DO UPDATE SET version = excluded.version, pose_at = excluded.pose_at, tagged_at = excluded.tagged_at,
       low_at = excluded.low_at, matched_at = excluded.matched_at`,
  );
  for (const { state: s, hits } of results) {
    for (const p of old.pluck().all(s.imageId) as string[]) touched.add(p);
    del.run(s.imageId);
    for (const h of hits) {
      touched.add(h.poseId);
      ins.run({
        imageId: s.imageId,
        poseId: h.poseId,
        score: round(h.score, 4),
        primary: h.primary ? 1 : 0,
        method: h.method,
        low: h.method === LOW_METHOD ? 1 : 0,
        distance: h.distance === null ? null : round(h.distance, 4),
        tagScore: round(h.tagScore, 3),
        view: h.view,
        now,
      });
    }
    state.run({ ...s, version, now });
  }
  return touched;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * 按姿势重排名次（从 1 开始）。单人：名次分高的在前；双人：骨架过了的在前、只靠标签的在后，各自按名次分，
 * 再按名次去差分（同一本合集、查重同一组、dHash 很近的只留最前那张）
 */
export function rerankPoseWear(db: Db, poseIds: Iterable<string>): void {
  const ids = [...new Set(poseIds)];
  if (!ids.length) return;
  const pairs = new Set(
    db.prepare("SELECT id FROM posewear_poses WHERE set_id = 'pair' AND id IN (SELECT value FROM json_each(?))").pluck().all(JSON.stringify(ids)) as string[],
  );
  const singles = ids.filter((p) => !pairs.has(p));
  if (singles.length)
    db.prepare(
      `UPDATE image_posewear_members AS m SET rank = r.rn
       FROM (SELECT image_id, pose_id, ROW_NUMBER() OVER (PARTITION BY pose_id ORDER BY score DESC, image_id) AS rn
             FROM image_posewear_members WHERE pose_id IN (SELECT value FROM json_each(@ids))) r
       WHERE m.image_id = r.image_id AND m.pose_id = r.pose_id AND m.rank IS NOT r.rn`,
    ).run({ ids: JSON.stringify(singles) });
  if (!pairs.size) return;
  const list = db
    .prepare(
      `SELECT image_id, pose_id, method, score FROM image_posewear_members WHERE pose_id IN (SELECT value FROM json_each(?))
       ORDER BY pose_id, method = 'tag_only', score DESC, image_id`,
    )
    .all(JSON.stringify([...pairs])) as { image_id: number; pose_id: string; method: string; score: number | null }[];
  const rows: PoseWearMemberRow[] = [];
  let pose = '';
  let rank = 0;
  for (const r of list) {
    if (r.pose_id !== pose) (pose = r.pose_id), (rank = 0);
    rows.push({ imageId: r.image_id, poseId: r.pose_id, rank: ++rank, primary: false, method: r.method, distance: null, tagScore: null, view: null });
  }
  const upd = stmt(db, 'UPDATE image_posewear_members SET rank = ?, variant_of = ? WHERE image_id = ? AND pose_id = ?');
  for (const r of markPairVariants(db, rows)) upd.run(r.rank, r.variantOf ?? null, r.imageId, r.poseId);
}

/** 提取过姿势的图全部记成「按现在的输入匹配过」（导入原型的匹配结果之后用） */
export function markAllMatched(db: Db, version: number, now: string): void {
  db.prepare(
    `INSERT INTO posewear_match_state (image_id, version, pose_at, tagged_at, low_at, matched_at)
     SELECT p.image_id, @version, p.updated_at, i.tagged_at, c.checked_at, @now
     FROM image_poses p JOIN images i ON i.id = p.image_id LEFT JOIN image_pose_tags_checked c ON c.image_id = p.image_id
     WHERE true
     ON CONFLICT(image_id) DO UPDATE SET version = excluded.version, pose_at = excluded.pose_at, tagged_at = excluded.tagged_at,
       low_at = excluded.low_at, matched_at = excluded.matched_at`,
  ).run({ version, now });
}

/** 全部重算：清掉匹配记录（下一轮「重新匹配姿势」整库重跑；匹配结果留着，重跑时一张张换掉） */
export function clearMatchState(db: Db): void {
  db.prepare('DELETE FROM posewear_match_state').run();
}

/** 别的模块换了一张图的输入（例如补了低分标签但没改识别时间）：让它下次重新匹配 */
export function markPoseWearStale(db: Db, imageIds: readonly number[]): void {
  db.prepare('DELETE FROM posewear_match_state WHERE image_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(imageIds));
}

/**
 * 要重新匹配的图（配合 JOIN library_roots r、JOIN image_poses p、LEFT JOIN posewear_match_state s、LEFT JOIN image_pose_tags_checked c）：
 * 计入统计的插画、提取过姿势的；没匹配过，或者姿势库版本、骨架、标签、低分标签换过
 */
export const MATCH_PENDING = `${POSE_ELIGIBLE} AND (s.image_id IS NULL OR s.version <> @version OR s.pose_at IS NOT p.updated_at
  OR s.tagged_at IS NOT i.tagged_at OR s.low_at IS NOT c.checked_at)`;
export const MATCH_FROM = `images i JOIN library_roots r ON r.id = i.root_id JOIN image_poses p ON p.image_id = i.id
  LEFT JOIN posewear_match_state s ON s.image_id = i.id LEFT JOIN image_pose_tags_checked c ON c.image_id = i.id`;

export function matchCounts(db: Db, version: number): { eligible: number; matched: number; pending: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS eligible, SUM(CASE WHEN ${MATCH_PENDING} THEN 1 ELSE 0 END) AS pending FROM ${MATCH_FROM} WHERE ${POSE_ELIGIBLE}`,
    )
    .get({ version }) as { eligible: number; pending: number | null };
  const pending = r.pending ?? 0;
  return { eligible: r.eligible, matched: r.eligible - pending, pending };
}
