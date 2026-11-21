/**
 * 随包的 PoseWear 姿势库（apps/server/assets/pose/posewear/，scripts/build-posewear-asset.ts 生成）：
 * catalog.json 是姿势目录、标签配方和匹配参数，skeletons.json 是每个视角线稿上的骨架（坐标按长边归一）。不含线稿图片。
 * 只读；第一次用到时读进来，代表骨架的特征按遮挡方式现算、缓存。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PoseWearSet } from '@emaki/shared';
import { config } from '../../config.ts';
import { NPTS, poseFeatures, type PoseFeatures, type Pt } from './features.ts';

/** 配方的一种写法：每个子句里任一个标签有就算，none_of 里的一个都不能有 */
export interface RecipeAlt {
  all_of_any: string[][];
  none_of: string[];
}

export interface SinglePoseAsset {
  id: string;
  set: Exclude<PoseWearSet, 'pair'>;
  number: string;
  name: string;
  category: string;
  sort: number;
  adult: boolean;
  views: string[];
  bestView: string;
  /** tag：配方点了具体标签；posture：只有身体姿态（强度算 0）；skeleton：没有配方，只看骨架 */
  level: 'tag' | 'posture' | 'skeleton';
  alts: RecipeAlt[];
  /** 躺卧一类：阈值放宽、图的骨架转 90° 也比 */
  lying: boolean;
  /** 「姿态」姿势（名字里没有手、臂这些细节）：阈值放宽 */
  posture: boolean;
  upper: boolean;
  /** 上半身姿势也在全身图上比（配方没点身体姿态） */
  upperOnFull: boolean;
  /** 有能用的视角；没有的只能按标签匹配 */
  hasView: boolean;
}

export interface PairMemberAsset {
  /** pair60 的编号（P009） */
  pose: string;
  alts: RecipeAlt[];
  hasView: boolean;
}

export interface PairPoseAsset {
  id: string;
  set: 'pair';
  number: string;
  name: string;
  category: string;
  sort: number;
  adult: boolean;
  views: string[];
  bestView: string;
  members: PairMemberAsset[];
}

export type PoseWearPoseAsset = SinglePoseAsset | PairPoseAsset;

export interface SingleParams {
  tagMin: number;
  lowMin: number;
  /** 按配方强度（0、1、2）的骨架阈值：全身、上半身 */
  thrFull: number[];
  thrUpper: number[];
  thrSkeleton: number;
  upperFactor: number;
  lyingFactor: number;
  postureFactor: number;
  postureFactorLying: number;
  lowFactor: number;
  lowKeyPenalty: number;
  upperOnFullPenalty: number;
  tagOnlyMin: number;
  generic: string[];
}

export interface PairParams {
  thr: number[];
  tagOnlyMin: number;
  generic: string[];
  defining: string[];
  count: Record<string, number>;
  exclude: string[];
  couple: string;
}

export interface CatalogFile {
  version: number;
  note: string;
  params: { single: SingleParams; pair: PairParams; rank: { skeleton: number; tags: number } };
  poses: PoseWearPoseAsset[];
}

/** 一个视角的骨架：kp 是 23 × (x, y) 摊平，按长边归一；w、h 也按长边归一 */
export interface ViewAsset {
  pose: string;
  view: string;
  kp: number[];
  ks: number[];
  w: number;
  h: number;
  nv: number;
  good: boolean;
  usable: boolean;
  armsDown: boolean;
  hip: number | null;
  kd: number | null;
  standingCat: boolean;
}

export interface PairViewAsset {
  pose: string;
  view: string;
  w: number;
  h: number;
  persons: { kp: number[]; ks: number[] }[];
}

interface SkeletonFile {
  version: number;
  views: ViewAsset[];
  pairViews: PairViewAsset[];
}

/** 遮挡方式：图的取景（mid 没有脚踝，waist 没有腿，bust 没有髋以下）；full 不遮 */
export type MaskMode = 'full' | 'mid' | 'waist' | 'bust';

export interface PreparedView extends ViewAsset {
  /** 姿势在 single 列表里的下标 */
  poseIndex: number;
  points: Pt[];
  feats: (mode: MaskMode) => PoseFeatures;
}

export interface PreparedPairView extends PairViewAsset {
  points: { kp: Pt[]; ks: number[] }[];
}

export interface PoseWearAsset {
  version: number;
  params: CatalogFile['params'];
  poses: PoseWearPoseAsset[];
  singles: SinglePoseAsset[];
  pairs: PairPoseAsset[];
  byId: Map<string, PoseWearPoseAsset>;
  /** 能用的单人视角 */
  views: PreparedView[];
  /** 全部单人视角（画小人用，含不能用的） */
  allViews: ViewAsset[];
  pairViews: PreparedPairView[];
}

export function maskKs(ks: readonly number[], mode: MaskMode): number[] {
  const out = [...ks];
  const from = mode === 'mid' ? 15 : mode === 'waist' ? 13 : mode === 'bust' ? 11 : NPTS;
  for (let i = from; i < NPTS; i++) out[i] = 0;
  return out;
}

export const toPoints = (flat: readonly number[]): Pt[] => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i]!, flat[2 * i + 1]!] as Pt);

export function buildPoseWearAsset(catalog: CatalogFile, skeletons: SkeletonFile): PoseWearAsset {
  const singles = catalog.poses.filter((p): p is SinglePoseAsset => p.set !== 'pair');
  const pairs = catalog.poses.filter((p): p is PairPoseAsset => p.set === 'pair');
  const index = new Map(singles.map((p, i) => [p.id, i]));
  const views: PreparedView[] = [];
  for (const v of skeletons.views) {
    const poseIndex = index.get(v.pose);
    if (!v.usable || poseIndex === undefined) continue;
    const points = toPoints(v.kp);
    const cache = new Map<MaskMode, PoseFeatures>();
    views.push({
      ...v,
      poseIndex,
      points,
      feats: (mode) => {
        let f = cache.get(mode);
        if (!f) cache.set(mode, (f = poseFeatures(points, maskKs(v.ks, mode))));
        return f;
      },
    });
  }
  return {
    version: catalog.version,
    params: catalog.params,
    poses: catalog.poses,
    singles,
    pairs,
    byId: new Map(catalog.poses.map((p) => [p.id, p])),
    views,
    allViews: skeletons.views,
    pairViews: skeletons.pairViews.map((v) => ({ ...v, points: v.persons.map((q) => ({ kp: toPoints(q.kp), ks: q.ks })) })),
  };
}

const cache = new Map<string, PoseWearAsset>();

export function loadPoseWearAsset(assetsDir = config.assetsDir): PoseWearAsset {
  const dir = path.join(assetsDir, 'pose', 'posewear');
  let a = cache.get(dir);
  if (!a) {
    const read = <T>(f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as T;
    a = buildPoseWearAsset(read<CatalogFile>('catalog.json'), read<SkeletonFile>('skeletons.json'));
    cache.set(dir, a);
  }
  return a;
}
