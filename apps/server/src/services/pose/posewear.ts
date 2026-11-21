/**
 * 导入 PoseWear 姿势库和姿势匹配结果（实验）。
 * - 姿势库：用户本机的 PoseWear 文件夹（assets/poses.*.json + p/t、p/i 线稿）。单人的三套照导；双人的 pair60 只导
 *   PAIR_TYPES 里几类的代表线稿，存成 pair_P054 这样。每个姿势复制全部视角的小图和代表视角的大图到 <数据目录>/pose/posewear/。
 *   PoseWear 的图不进仓库。
 * - 单人匹配：原型 posewear_final 的 assignments_multi_weighted.json（图片 id → 取景、全部过了阈值的姿势，每个带名次、加权分、方法、是不是主要的；
 *   名次按 0.6·骨架相似 + 0.4·标签分排，低置信的不另外往后挪，这里照用）；
 *   旧的 posewear_v1 assignments.json（主要姿势 + 前三个候选）也认。
 * - 双人匹配：pose-pair tags_v1 的 assignments.json（图片 id → 前三个 pair60 候选）：按 PAIR_TYPES 并成互动类型，
 *   一类里按「骨架过了的在前（距离近的先），只靠标签的在后（强度、子句数、标签分）」排名次，再去差分。
 * 只导本图库里有的图。
 * TODO 新图的 PoseWear 匹配还没做：要重跑原型再导一次匹配结果。
 */
import { PAIR_ADULT_CATEGORY, PAIR_TYPES, POSEWEAR_SINGLE_SETS, type PoseWearSet } from '@emaki/shared';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import {
  LOW_METHOD,
  markPairVariants,
  posewearPoseIds,
  replacePoseWearMembers,
  writePoseWearPoses,
  type PoseWearMemberRow,
  type PoseWearPoseRow,
} from '../../domain/pose/posewear.ts';

const VIEWS = ['front', 'high', 'low', 'side', 'diag'] as const;

/** 开发机上的默认位置（找得到才给） */
const FOLDER_CANDIDATES = ['F:/CodexArchive/Documents/Codex/2026-11-20/https-posewear-pages-dev-pose-https/outputs/PoseWear'];
const ASSIGN_CANDIDATES = [
  // 名次按 0.6·骨架相似 + 0.4·标签分重排过的那份优先
  'F:/Claude/.work/pose-proto/out/posewear_final/assignments_multi_weighted.json',
  'F:/Claude/.work/pose-proto/out/posewear_final/assignments_multi.json',
  'F:/Claude/.work/pose-proto/out/posewear_v1/assignments.json',
];
const PAIRS_CANDIDATES = ['F:/Claude/.work/pose-pair/tags_v1/assignments.json'];

export function localPoseWear(): { folder: string | null; assignmentsPath: string | null; viewsPath: string | null; pairsPath: string | null } {
  const assignmentsPath = ASSIGN_CANDIDATES.find((f) => existsSync(f)) ?? null;
  // 原型的 poses.json 在匹配结果旁边：给代表视角
  const views = assignmentsPath ? `${path.posix.dirname(assignmentsPath.replace(/\\/g, '/'))}/poses.json` : null;
  return {
    folder: FOLDER_CANDIDATES.find((d) => existsSync(d) && findPoseList(d) !== null) ?? null,
    assignmentsPath,
    viewsPath: views && existsSync(views) ? views : null,
    pairsPath: PAIRS_CANDIDATES.find((f) => existsSync(f)) ?? null,
  };
}

/** 线稿放在这里：t/ 小图，i/ 大图 */
export const posewearDir = (ctx: Pick<SqliteContext, 'dataDir'>) => path.join(ctx.dataDir, 'pose', 'posewear');

/** PoseWear 的姿势列表：网站构建出来的 assets/poses.<hash>.json，或者根目录的 poses.json */
export function findPoseList(folder: string): string | null {
  const assets = path.join(folder, 'assets');
  if (existsSync(assets)) {
    const hit = readdirSync(assets).filter((f) => /^poses\.[0-9a-f]+\.json$/.test(f)).sort();
    if (hit.length) return path.join(assets, hit.at(-1)!);
  }
  const root = path.join(folder, 'poses.json');
  return existsSync(root) ? root : null;
}

interface SourcePose {
  id: string;
  no: string;
  zh: string;
  cat: string;
  angles: { t: string; i: string }[];
}

const viewOf = (file: string) => VIEWS.find((v) => file.endsWith(`_${v}.webp`)) ?? null;

export async function importPoseWear(ctx: SqliteContext, folder: string, viewsPath?: string): Promise<{ poses: number; pairTypes: number; files: number }> {
  const listPath = findPoseList(folder);
  if (!listPath) throw new Error(`${folder} 里没有姿势列表（assets/poses.*.json 或 poses.json），不是 PoseWear 的文件夹？`);
  const list = JSON.parse(await readFile(listPath, 'utf8')) as SourcePose[];
  if (!Array.isArray(list)) throw new Error(`${listPath} 不是姿势列表`);
  // 原型挑的代表视角（匹配时最好用的那一张）；没有就用正面
  const best = new Map<string, string>();
  if (viewsPath) {
    const v = JSON.parse(await readFile(viewsPath, 'utf8')) as Record<string, { best_view?: string | null }>;
    for (const [id, p] of Object.entries(v)) if (p.best_view) best.set(id, p.best_view.slice(id.length + 1));
  }

  const out = posewearDir(ctx);
  await mkdir(path.join(out, 't'), { recursive: true });
  await mkdir(path.join(out, 'i'), { recursive: true });
  let files = 0;
  /** 复制一个姿势的小图（全部视角）和大图（代表视角），存成 id_视角.webp；返回有的视角和代表视角 */
  const copyArt = async (p: SourcePose, id: string, want: string | undefined) => {
    const views: string[] = [];
    for (const a of p.angles ?? []) {
      const v = viewOf(a.t);
      const src = path.join(folder, a.t);
      if (!v || !existsSync(src)) continue;
      await copyFile(src, path.join(out, 't', `${id}_${v}.webp`));
      files++;
      views.push(v);
    }
    if (!views.length) return null;
    const bestView = want && views.includes(want) ? want : views.includes('front') ? 'front' : views[0]!;
    const big = path.join(folder, 'p', 'i', `${p.id}_${bestView}.webp`);
    // 大图不在就用小图顶上
    await copyFile(existsSync(big) ? big : path.join(out, 't', `${id}_${bestView}.webp`), path.join(out, 'i', `${id}_${bestView}.webp`));
    files++;
    return { views, bestView };
  };

  const rows: PoseWearPoseRow[] = [];
  for (const [sort, p] of list.entries()) {
    const set = POSEWEAR_SINGLE_SETS.find((s) => p.id === `${s}_${p.no}`) as PoseWearSet | undefined;
    if (!set || !/^P\d{3}$/.test(p.no)) continue;
    const art = await copyArt(p, p.id, best.get(p.id));
    if (!art) continue;
    rows.push({ id: p.id, set, number: p.no, name: p.zh, category: p.cat, sort, ...art, adult: false });
  }
  const singles = rows.length;
  if (!singles) throw new Error(`${listPath} 里没有单人姿势（full_single、full_sexy、upper80v2）`);
  // 双人：每类用代表那张 pair60 的线稿；排在单人后面
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const [k, t] of PAIR_TYPES.entries()) {
    const src = byId.get(`pair60_${t.rep}`);
    if (!src) continue;
    const id = `pair_${t.rep}`;
    const art = await copyArt(src, id, undefined);
    if (!art) continue;
    rows.push({ id, set: 'pair', number: t.rep, name: t.name, category: t.adult ? PAIR_ADULT_CATEGORY : '双人', sort: 100_000 + k, ...art, adult: t.adult });
  }
  ctx.apply(() => {
    writePoseWearPoses(ctx.db, rows);
    ctx.changed({ type: 'pose.changed', ids: [] });
  });
  return { poses: singles, pairTypes: rows.length - singles, files };
}

// ------------------------------------------------------------------ 匹配结果

interface SourceMultiPose {
  pose_id: string;
  rank?: number;
  primary?: boolean;
  method?: string;
  distance?: number | null;
  tag_score?: number | null;
  /** 加权分（0.6·骨架相似 + 0.4·标签分）；名次就是按它排的 */
  score?: number | null;
  view?: string | null;
}
interface SourceAssignment {
  pose_id?: string;
  distance?: number | null;
  tag_score?: number | null;
  method?: string;
  rank?: number;
  view?: string | null;
  candidates?: { pose_id: string; accepted?: boolean; distance?: number | null; tag_score?: number | null; method?: string | null }[];
  /** assignments_multi.json：全部过了阈值的姿势 */
  poses?: SourceMultiPose[];
}

const numOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** 原型记的视角是 full_single_P001_side 这样，只留 side */
const viewName = (v: unknown) => (typeof v === 'string' && v ? viewOf(`${v}.webp`) : null);

async function readMap<T>(file: string): Promise<Record<string, T>> {
  const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, T>;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${file} 不是匹配结果（应该是 图片 id → 姿势）`);
  return data;
}

function existing(ctx: SqliteContext, ids: number[]): Set<number> {
  return new Set(ctx.db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(ids)) as number[]);
}

/** 单人：一张图的全部（图, 姿势）。新格式给 poses；旧格式给主要姿势 + 过了阈值的候选（候选没有名次，排在最后） */
export function singleMembers(id: number, a: SourceAssignment, known: Set<string>): PoseWearMemberRow[] {
  if (Array.isArray(a.poses)) {
    const seen = new Set<string>();
    return a.poses.flatMap((p) => {
      if (!p?.pose_id || !known.has(p.pose_id) || seen.has(p.pose_id)) return [];
      seen.add(p.pose_id);
      return [
        {
          imageId: id,
          poseId: p.pose_id,
          rank: Number.isInteger(p.rank) ? p.rank! : 0,
          primary: !!p.primary,
          method: String(p.method ?? ''),
          distance: numOrNull(p.distance),
          tagScore: numOrNull(p.tag_score),
          score: numOrNull(p.score),
          view: viewName(p.view),
        },
      ];
    });
  }
  if (!a.pose_id || !known.has(a.pose_id)) return [];
  const main: PoseWearMemberRow = {
    imageId: id,
    poseId: a.pose_id,
    rank: Number.isInteger(a.rank) ? a.rank! : 0,
    primary: true,
    method: String(a.method ?? ''),
    distance: numOrNull(a.distance),
    tagScore: numOrNull(a.tag_score),
    view: viewName(a.view),
  };
  const others = (a.candidates ?? [])
    .slice(0, 3)
    .map((c, ord) => ({ c, ord }))
    .filter(({ c }) => c.accepted && known.has(c.pose_id) && c.pose_id !== a.pose_id)
    .map(({ c, ord }) => ({
      imageId: id,
      poseId: c.pose_id,
      rank: 1_000_000 + ord,
      primary: false,
      method: String(c.method ?? ''),
      distance: numOrNull(c.distance),
      tagScore: numOrNull(c.tag_score),
      view: null,
    }));
  return [main, ...others];
}

interface SourcePairCandidate {
  pose: string;
  accepted?: boolean;
  method?: string;
  strength?: number;
  nclause?: number;
  tag_score?: number;
  distance?: number | null;
  dist_norm?: number | null;
}
interface SourcePair {
  pose?: string | null;
  top3?: SourcePairCandidate[];
}

/** pair60 姿势 → 双人类型的 id（pair_P054） */
const PAIR_OF = new Map<string, string>(PAIR_TYPES.flatMap((t) => t.members.map((m) => [`pair60_${m}`, `pair_${t.rep}`] as const)));

/** 一类里的排序键：骨架过了的在前（距离近的先），只靠标签的在后（强度、子句数、标签分高的先） */
function pairKey(c: SourcePairCandidate): number[] {
  if (c.method === 'tags+skel') return [0, c.dist_norm ?? 9];
  return [1, -(c.strength ?? 0), -(c.nclause ?? 0), -(c.tag_score ?? 0)];
}
function cmpKey(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

type PairHit = { id: number; c: SourcePairCandidate; primary: boolean };

/** 双人：按类型合并、排名次（一张图在一类里只一行，取这一类里最像的那个候选） */
export function pairMembers(data: Record<string, SourcePair>, exists: Set<number>, known: Set<string>): PoseWearMemberRow[] {
  const byType = new Map<string, Map<number, PairHit>>();
  for (const [key, a] of Object.entries(data)) {
    const id = Number(key);
    if (!exists.has(id)) continue;
    const primaryType = a?.pose ? PAIR_OF.get(a.pose) : undefined;
    for (const c of a?.top3 ?? []) {
      const type = PAIR_OF.get(c.pose);
      if (!c.accepted || !type || !known.has(type)) continue;
      const hits = byType.get(type) ?? new Map<number, PairHit>();
      byType.set(type, hits);
      const cur = hits.get(id);
      if (!cur || cmpKey(pairKey(c), pairKey(cur.c)) < 0) hits.set(id, { id, c, primary: primaryType === type });
    }
  }
  const rows: PoseWearMemberRow[] = [];
  for (const [type, hits] of byType) {
    const list = [...hits.values()].sort((a, b) => cmpKey(pairKey(a.c), pairKey(b.c)) || a.id - b.id);
    list.forEach(({ id, c, primary }, rank) =>
      rows.push({
        imageId: id,
        poseId: type,
        rank,
        primary,
        method: String(c.method ?? ''),
        distance: numOrNull(c.distance),
        tagScore: numOrNull(c.tag_score),
        view: null,
      }),
    );
  }
  return rows;
}

export interface PoseWearAssignCounts {
  imported: number;
  memberships: number;
  low: number;
  pairImages: number;
  pairVariants: number;
  missing: number;
  unknownPose: number;
}

/** 导入匹配结果：给了哪份换哪份（单人、双人各自整批替换） */
export async function importPoseWearAssignments(ctx: SqliteContext, files: { assignmentsPath?: string; pairsPath?: string }): Promise<PoseWearAssignCounts> {
  const known = posewearPoseIds(ctx.db);
  if (!known.size) throw new Error('还没有导入 PoseWear 姿势库：先导入姿势库');
  const r: PoseWearAssignCounts = { imported: 0, memberships: 0, low: 0, pairImages: 0, pairVariants: 0, missing: 0, unknownPose: 0 };
  let singles: PoseWearMemberRow[] | null = null;
  let pairs: PoseWearMemberRow[] | null = null;

  if (files.assignmentsPath) {
    const data = await readMap<SourceAssignment>(files.assignmentsPath);
    const ids = Object.keys(data).map(Number).filter(Number.isInteger);
    const exists = existing(ctx, ids);
    r.missing += ids.length - exists.size;
    singles = [];
    for (const id of ids) {
      if (!exists.has(id)) continue;
      const m = singleMembers(id, data[String(id)]!, known);
      if (!m.length) r.unknownPose++;
      singles.push(...m);
    }
    r.imported = new Set(singles.map((m) => m.imageId)).size;
    r.memberships = singles.length;
    r.low = singles.filter((m) => m.method === LOW_METHOD).length;
  }
  if (files.pairsPath) {
    if (![...known].some((id) => id.startsWith('pair_'))) throw new Error('姿势库里还没有双人：重新导入一次 PoseWear 姿势库');
    const data = await readMap<SourcePair>(files.pairsPath);
    const ids = Object.keys(data).map(Number).filter(Number.isInteger);
    pairs = markPairVariants(ctx.db, pairMembers(data, existing(ctx, ids), known));
    r.pairImages = new Set(pairs.map((m) => m.imageId)).size;
    r.pairVariants = pairs.filter((m) => m.variantOf != null).length;
  }

  const now = new Date(ctx.clock()).toISOString();
  ctx.apply(() => {
    const touched = new Set<number>();
    if (singles) for (const id of [...replacePoseWearMembers(ctx.db, 'single', singles, now), ...singles.map((m) => m.imageId)]) touched.add(id);
    if (pairs) for (const id of [...replacePoseWearMembers(ctx.db, 'pair', pairs, now), ...pairs.map((m) => m.imageId)]) touched.add(id);
    ctx.changed({ type: 'pose.changed', ids: [...touched] });
  });
  return r;
}
