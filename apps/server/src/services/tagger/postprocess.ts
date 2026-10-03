/**
 * 模型输出（概率）→ rating / general / character。比较一律用 >=（和「≥ 阈值自动采纳」语义一致）。
 */
import type { Rating } from '@emaki/shared';
import type { Labels } from './labels.ts';

export const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];

export interface DecodeOptions {
  generalThreshold: number;
  characterThreshold: number;
  generalMcut?: boolean;
  characterMcut?: boolean;
  maxGeneral?: number;
  maxCharacter?: number;
  /** 给了就解码画师（模型有画师输出时）；不给就不解码，结果里没有 artist */
  artistThreshold?: number;
}

export interface Decoded {
  rating: Record<Rating, number> | null;
  general: [string, number][];
  character: [string, number][];
  /** 只有模型能认画师、又要求解码时才有 */
  artist?: [string, number][];
}

/** MCut（Largeron 2012），与 app.py 一致：降序排序，取相邻差最大处的中点 */
export function mcutThreshold(values: ArrayLike<number>): number {
  const s = Array.from(values).sort((a, b) => b - a);
  if (s.length < 2) return s.length ? s[0]! : 1;
  let t = 0;
  let best = -Infinity;
  for (let i = 0; i < s.length - 1; i++) {
    const d = s[i]! - s[i + 1]!;
    if (d > best) {
      best = d;
      t = i;
    }
  }
  return (s[t]! + s[t + 1]!) / 2;
}

/** 保留 4 位小数，省 IPC 和数据库体积 */
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function pick(p: Float32Array, off: number, idx: number[], names: string[], thr: number, max: number): [string, number][] {
  const out: [string, number][] = [];
  for (const i of idx) {
    const v = p[off + i]!;
    if (v >= thr) out.push([names[i]!, r4(v)]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, max);
}

export function decodeRow(p: Float32Array, off: number, L: Labels, o: DecodeOptions): Decoded {
  let rating: Decoded['rating'] = null;
  if (L.ratingIdx.length === 4) {
    rating = { general: 0, sensitive: 0, questionable: 0, explicit: 0 };
    for (const i of L.ratingIdx) rating[L.names[i] as Rating] = r4(p[off + i]!);
  }
  const g = o.generalMcut ? mcutThreshold(L.generalIdx.map((i) => p[off + i]!)) : o.generalThreshold;
  // 0.15 下限同 app.py
  const c = o.characterMcut ? Math.max(0.15, mcutThreshold(L.characterIdx.map((i) => p[off + i]!))) : o.characterThreshold;
  return {
    rating,
    general: pick(p, off, L.generalIdx, L.names, g, o.maxGeneral ?? 80),
    character: pick(p, off, L.characterIdx, L.names, c, o.maxCharacter ?? 10),
    ...(o.artistThreshold !== undefined && L.artistIdx.length ? { artist: pick(p, off, L.artistIdx, L.names, o.artistThreshold, 2) } : {}),
  };
}

export function pickRating(r: Record<Rating, number>): Rating {
  return RATINGS.reduce((a, b) => (r[b] > r[a] ? b : a));
}
