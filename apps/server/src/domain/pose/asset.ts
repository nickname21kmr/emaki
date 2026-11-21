/**
 * 随仓库分发的姿势类别（apps/server/assets/pose/classes.json + figs/*.png）：原型在 6.6 万张图上聚出来的 51 类。
 * 生成脚本在原型目录外（F:/Claude/.work/pose-ext/scripts/build_assets.py），这里只读。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import { poseFeatures, type ClassRef, type Pt } from './features.ts';

export interface PoseClassAsset {
  id: string;
  group: 'full' | 'mid' | 'waist' | 'bust';
  name: string;
  description: string;
  coherence: string;
  size: number;
  medoidImageId: number;
  cut: number;
  medianDistance: number | null;
  medoid: { kp: Pt[]; ks: number[] };
  figure: string;
}

export interface PoseAsset {
  version: number;
  source: string;
  groups: { id: string; name: string }[];
  classes: PoseClassAsset[];
}

const cache = new Map<string, PoseAsset>();

export function poseAssetDir(assetsDir = config.assetsDir): string {
  return path.join(assetsDir, 'pose');
}

export function loadPoseAsset(assetsDir = config.assetsDir): PoseAsset {
  const dir = poseAssetDir(assetsDir);
  let a = cache.get(dir);
  if (!a) {
    a = JSON.parse(readFileSync(path.join(dir, 'classes.json'), 'utf8')) as PoseAsset;
    cache.set(dir, a);
  }
  return a;
}

/** 资产里的文件（示意小人 figs/*.png），路径相对 assets/pose/ */
export function readPoseAssetFile(rel: string, assetsDir = config.assetsDir): Buffer {
  return readFileSync(path.join(poseAssetDir(assetsDir), rel));
}

/** 归类用的代表骨架特征 */
export function classRefs(asset: PoseAsset): ClassRef[] {
  return asset.classes.map((c) => ({ id: c.id, group: c.group, cut: c.cut, features: poseFeatures(c.medoid.kp, c.medoid.ks) }));
}
