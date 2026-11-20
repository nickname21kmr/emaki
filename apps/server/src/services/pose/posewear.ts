/**
 * 导入 PoseWear 姿势库和姿势匹配结果（实验）。
 * - 姿势库：用户本机的 PoseWear 文件夹（assets/poses.*.json + p/t、p/i 线稿）。只导单人的三套，双人的 pair60 跳过；
 *   每个姿势复制全部视角的小图和代表视角的大图到 <数据目录>/pose/posewear/。PoseWear 的图不进仓库。
 * - 匹配结果：原型 posewear_v1 的 assignments.json（图片 id → 主要姿势、距离、名次和前三个候选）。只导本图库里有的图。
 * TODO 新图的 PoseWear 匹配还没做：「提取姿势」照常给新图提骨架，但不匹配 PoseWear（原型 run_v1.py 的标签配方 + 骨架距离还没搬过来），
 * 要重跑原型再导一次匹配结果。
 */
import { POSEWEAR_SETS, type PoseWearSet } from '@emaki/shared';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { posewearPoseIds, replacePoseWearAssignments, writePoseWearPoses, type PoseWearAssignRow, type PoseWearPoseRow } from '../../domain/pose/posewear.ts';

const VIEWS = ['front', 'high', 'low', 'side', 'diag'] as const;

/** 开发机上的默认位置（找得到才给） */
const FOLDER_CANDIDATES = ['F:/CodexArchive/Documents/Codex/2026-11-20/https-posewear-pages-dev-pose-https/outputs/PoseWear'];
const ASSIGN_CANDIDATES = ['F:/Claude/.work/pose-proto/out/posewear_v1/assignments.json'];

export function localPoseWear(): { folder: string | null; assignmentsPath: string | null } {
  return {
    folder: FOLDER_CANDIDATES.find((d) => existsSync(d) && findPoseList(d) !== null) ?? null,
    assignmentsPath: ASSIGN_CANDIDATES.find((f) => existsSync(f)) ?? null,
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

export async function importPoseWear(ctx: SqliteContext, folder: string, viewsPath?: string): Promise<{ poses: number; files: number }> {
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
  const rows: PoseWearPoseRow[] = [];
  let files = 0;
  for (const [sort, p] of list.entries()) {
    const set = POSEWEAR_SETS.find((s) => p.id === `${s}_${p.no}`) as PoseWearSet | undefined;
    if (!set || !/^P\d{3}$/.test(p.no)) continue;
    const views: string[] = [];
    for (const a of p.angles ?? []) {
      const v = viewOf(a.t);
      const src = path.join(folder, a.t);
      if (!v || !existsSync(src)) continue;
      await copyFile(src, path.join(out, 't', `${p.id}_${v}.webp`));
      files++;
      views.push(v);
    }
    if (!views.length) continue;
    const want = best.get(p.id);
    const bestView = want && views.includes(want) ? want : views.includes('front') ? 'front' : views[0]!;
    const big = path.join(folder, 'p', 'i', `${p.id}_${bestView}.webp`);
    // 大图不在就用小图顶上
    await copyFile(existsSync(big) ? big : path.join(out, 't', `${p.id}_${bestView}.webp`), path.join(out, 'i', `${p.id}_${bestView}.webp`));
    files++;
    rows.push({ id: p.id, set, number: p.no, name: p.zh, category: p.cat, sort, views, bestView });
  }
  if (!rows.length) throw new Error(`${listPath} 里没有单人姿势（full_single、full_sexy、upper80v2）`);
  ctx.apply(() => {
    writePoseWearPoses(ctx.db, rows);
    ctx.changed({ type: 'pose.changed', ids: [] });
  });
  return { poses: rows.length, files };
}

interface SourceAssignment {
  pose_id: string;
  distance?: number | null;
  tag_score?: number | null;
  method: string;
  rank?: number;
  view?: string | null;
  candidates?: { pose_id: string; accepted?: boolean; distance?: number | null; tag_score?: number | null; method?: string | null }[];
}

const numOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export async function importPoseWearAssignments(
  ctx: SqliteContext,
  file: string,
): Promise<{ imported: number; candidates: number; missing: number; unknownPose: number }> {
  const known = posewearPoseIds(ctx.db);
  if (!known.size) throw new Error('还没有导入 PoseWear 姿势库：先导入姿势库');
  const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, SourceAssignment>;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${file} 不是匹配结果（应该是 图片 id → 姿势）`);
  const ids = Object.keys(data).map(Number).filter(Number.isInteger);
  const exists = new Set(ctx.db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(ids)) as number[]);
  const rows: PoseWearAssignRow[] = [];
  let unknownPose = 0;
  for (const id of ids) {
    if (!exists.has(id)) continue;
    const a = data[String(id)]!;
    if (!a?.pose_id || !known.has(a.pose_id)) {
      unknownPose++;
      continue;
    }
    rows.push({
      imageId: id,
      poseId: a.pose_id,
      distance: numOrNull(a.distance),
      tagScore: numOrNull(a.tag_score),
      method: String(a.method ?? ''),
      rank: Number.isInteger(a.rank) ? a.rank! : 0,
      view: a.view ? viewOf(`${a.view}.webp`) : null,
      candidates: (a.candidates ?? [])
        .filter((c) => known.has(c.pose_id))
        .slice(0, 3)
        .map((c) => ({ poseId: c.pose_id, accepted: !!c.accepted, distance: numOrNull(c.distance), tagScore: numOrNull(c.tag_score), method: c.method ?? null })),
    });
  }
  const now = new Date(ctx.clock()).toISOString();
  ctx.apply(() => {
    const before = replacePoseWearAssignments(ctx.db, rows, now);
    ctx.changed({ type: 'pose.changed', ids: [...new Set([...before, ...rows.map((r) => r.imageId)])] });
  });
  return { imported: rows.length, candidates: rows.reduce((s, r) => s + r.candidates.length, 0), missing: ids.length - exists.size, unknownPose };
}
