/**
 * PoseWear 姿势在 Emaki 里匹配（实验）：读一批图的输入（image_poses 的主要人物、像样的人数、两人骨架；image_tags 里 ≥ 0.35 的标签；
 * 证据模块的低分姿势标签 image_pose_tags_low），跑 domain/pose/posewearMatch.ts，按图整体替换匹配，再按姿势重排名次。
 * - 「提取姿势」每写完一批就匹配那一批（matchImages），新用户打开功能后不用再做什么；
 * - 后台任务「重新匹配姿势」（JOB_KINDS['pose-match']，io 道）补骨架、标签换过的图和姿势库升级后的整库重算，
 *   按 posewear_match_state 接着做，可以取消。
 */
import { formatEta } from '@emaki/shared';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import { unpackPerson } from '../../domain/pose/features.ts';
import { unpackPair } from '../../domain/pose/pairs.ts';
import { loadPoseWearAsset, type MaskMode, type PoseWearAsset } from '../../domain/pose/posewearAsset.ts';
import { matchPair, matchSingle, type PoseWearHit } from '../../domain/pose/posewearMatch.ts';
import {
  clearMatchState,
  MATCH_FROM,
  MATCH_PENDING,
  matchVersion,
  replaceImageMatches,
  rerankPoseWear,
  syncPoseWearCatalog,
  type MatchState,
} from '../../domain/pose/posewearStore.ts';

const GROUPS = new Set<string>(['full', 'mid', 'waist', 'bust']);
/** 「重新匹配姿势」一批的张数 */
const BATCH = 400;

/** 姿势目录随包分发：和资产不一样时写进库（启动、打开功能、跑任务前） */
export function ensurePoseWearCatalog(ctx: SqliteContext, asset: PoseWearAsset = loadPoseWearAsset()): void {
  ctx.apply(() => {
    if (syncPoseWearCatalog(ctx.db, asset)) ctx.changed({ type: 'pose.changed', ids: [] });
  });
}

interface InputRow {
  id: number;
  tagged_at: string | null;
  grp: string | null;
  keypoints: Buffer | null;
  npers: number | null;
  pair: Buffer | null;
  pose_at: string;
  low_at: string | null;
}

/** 一批图：每张的匹配（单人 + 双人）和用的输入；没提取过姿势的图不在里面 */
export function computeMatches(ctx: SqliteContext, ids: readonly number[], asset: PoseWearAsset): { state: MatchState; hits: PoseWearHit[] }[] {
  const db = ctx.db;
  const list = JSON.stringify(ids);
  const rows = db
    .prepare(
      `SELECT i.id, i.tagged_at, p.grp, p.keypoints, p.npers, p.pair, p.updated_at AS pose_at, c.checked_at AS low_at
       FROM images i JOIN image_poses p ON p.image_id = i.id LEFT JOIN image_pose_tags_checked c ON c.image_id = i.id
       WHERE i.id IN (SELECT value FROM json_each(?))`,
    )
    .all(list) as InputRow[];
  const tags = new Map<number, Map<string, number>>();
  const low = new Map<number, Map<string, number>>();
  const put = (m: Map<number, Map<string, number>>, r: { id: number; name: string; score: number }) => {
    let x = m.get(r.id);
    if (!x) m.set(r.id, (x = new Map()));
    x.set(r.name, r.score);
  };
  for (const r of db
    .prepare('SELECT it.image_id AS id, t.name, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.score >= ? AND it.image_id IN (SELECT value FROM json_each(?))')
    .all(asset.params.single.tagMin, list) as { id: number; name: string; score: number }[])
    put(tags, r);
  for (const r of db
    .prepare('SELECT l.image_id AS id, t.name, l.score FROM image_pose_tags_low l JOIN tags t ON t.id = l.tag_id WHERE l.image_id IN (SELECT value FROM json_each(?))')
    .all(list) as { id: number; name: string; score: number }[])
    put(low, r);
  const none = new Map<string, number>();
  return rows.map((r) => {
    const tg = tags.get(r.id) ?? none;
    const hits: PoseWearHit[] = [];
    // 单人：有主要人物、取景在四组里、只有一个像样的人（以前提取的没记人数，当 1 个人）
    if (r.keypoints && r.grp && GROUPS.has(r.grp) && (r.npers === null || r.npers === 1)) {
      const { person } = unpackPerson(r.keypoints);
      hits.push(...matchSingle(asset, { group: r.grp as MaskMode, kp: person.kp, ks: person.ks, tags: tg, low: low.get(r.id) ?? null }));
    }
    hits.push(...matchPair(asset, { tags: tg, pair: r.pair ? unpackPair(r.pair) : null }));
    return { state: { imageId: r.id, poseAt: r.pose_at, taggedAt: r.tagged_at, lowAt: r.low_at }, hits };
  });
}

/** 重新匹配这些图并写入（一个事务），名次按动到的姿势重排；返回匹配上的（图, 姿势）数 */
export function matchImages(ctx: SqliteContext, ids: readonly number[], asset: PoseWearAsset = loadPoseWearAsset()): number {
  if (!ids.length) return 0;
  const results = computeMatches(ctx, ids, asset);
  if (!results.length) return 0;
  const now = new Date(ctx.clock()).toISOString();
  ctx.apply(() => {
    const touched = replaceImageMatches(ctx.db, results, matchVersion(asset), now);
    rerankPoseWear(ctx.db, touched);
    ctx.changed({ type: 'pose.changed', ids: results.map((r) => r.state.imageId) });
  });
  return results.reduce((s, r) => s + r.hits.length, 0);
}

/** 要重新匹配的张数（计入统计、提取过姿势的插画里） */
export function matchPendingCount(ctx: SqliteContext, asset: PoseWearAsset = loadPoseWearAsset()): number {
  return ctx.db.prepare(`SELECT COUNT(*) FROM ${MATCH_FROM} WHERE ${MATCH_PENDING}`).pluck().get({ version: matchVersion(asset) }) as number;
}

/** 全部重算：清掉匹配记录（下一轮「重新匹配姿势」整库重跑） */
export function resetMatchState(ctx: SqliteContext): void {
  ctx.apply(() => clearMatchState(ctx.db));
}

export interface PoseMatchStageDeps {
  ctx: SqliteContext;
  asset?: () => PoseWearAsset;
}

export function createPoseMatchStage(deps: PoseMatchStageDeps) {
  const { ctx } = deps;
  const asset = deps.asset ?? (() => loadPoseWearAsset());
  return {
    enabled: () => readSettings(ctx.db).pose.enabled,
    pendingCount: () => matchPendingCount(ctx, asset()),
    async run(job: JobContext): Promise<string> {
      if (!readSettings(ctx.db).pose.enabled) return '重新匹配姿势：设置里没有打开';
      const a = asset();
      ensurePoseWearCatalog(ctx, a);
      const version = matchVersion(a);
      const total = matchPendingCount(ctx, a);
      job.setTotal(total);
      if (!total) return '重新匹配姿势：没有要匹配的图';
      const sel = ctx.db.prepare(`SELECT i.id FROM ${MATCH_FROM} WHERE ${MATCH_PENDING} AND i.id < @before ORDER BY i.id DESC LIMIT @limit`).pluck();
      let before = Number.MAX_SAFE_INTEGER;
      let done = 0;
      let hits = 0;
      const t0 = performance.now();
      const summary = () => `这次匹配了 ${done} 张，${hits} 个图-姿势`;
      for (;;) {
        if (job.signal.aborted) return `重新匹配姿势：已取消（${summary()}）`;
        if (job.shouldYield()) {
          job.requeue();
          return `重新匹配姿势：已让出（${summary()}）`;
        }
        const ids = sel.all({ version, before, limit: BATCH }) as number[];
        if (!ids.length) break;
        before = ids.at(-1)!;
        hits += matchImages(ctx, ids, a);
        done += ids.length;
        const rate = done / ((performance.now() - t0) / 1000);
        const left = Math.max(0, total - done) / rate;
        job.setEta?.(left);
        job.advance(ids.length, `重新匹配姿势：${done} / ${total} · ${rate.toFixed(0)} 张/秒 · 剩余约 ${formatEta(left) ?? '—'}`);
        // 让出事件循环：一批是同步算的
        await new Promise((r) => setImmediate(r));
      }
      return `重新匹配姿势：${summary()}`;
    },
  };
}

export type PoseMatchStage = ReturnType<typeof createPoseMatchStage>;
