/**
 * 双人的骨架：从一张图检测到的人里挑出两个人（原型 pose-pair/scripts/lib_pairs.py 的移植），
 * 和两人骨架之间的距离（pairfeat.py：每个人的姿势距离 + 两人之间的相对位置，各占一半）。纯函数。
 */
import { check, NPTS, poseDistance, poseFeatures, THR, type DetectedPerson, type PoseFeatures, type Pt } from './features.ts';

/** 挑人的门槛：检测框分数至少多少、一个人至少几个身体点置信度 > 0.5（按找人模型，见 store.ts 的 pairOptions） */
export interface PairOptions {
  scoreMin: number;
  minPoints: number;
}
/** YOLOX 找人时原型用的（lib_pairs.py） */
export const YOLOX_PAIR: PairOptions = { scoreMin: 0.3, minPoints: 9 };
const LIMBJ = [7, 8, 9, 10, 13, 14, 15, 16];

export interface PairPerson {
  kp: Pt[];
  ks: number[];
}

/** 挑出的两个人（大的在前）和检测到的像样的人数 */
export interface Pair {
  a: PairPerson;
  b: PairPerson;
  count: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function torso(kp: readonly Pt[], ks: readonly number[]): number {
  const ms = mid(kp[5]!, kp[6]!);
  if (ks[11]! > THR && ks[12]! > THR) return dist(ms, mid(kp[11]!, kp[12]!));
  return dist(kp[5]!, kp[6]!) * 1.6;
}

function extent(kp: readonly Pt[], ks: readonly number[]): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 17; i++)
    if (ks[i]! > THR) {
      xs.push(kp[i]![0]);
      ys.push(kp[i]![1]);
    }
  if (!xs.length) return 0;
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

const strong = (ks: readonly number[], thr: number) => ks.slice(0, 17).filter((s) => s > thr).length;
const ok = (p: PairPerson, box: DetectedPerson['box'], w: number, h: number, min: number) =>
  check({ box, score: 1, fallback: false, kp: p.kp, ks: p.ks }, w, h) === null && strong(p.ks, 0.5) >= min;

/**
 * 两个人：不是兜底框、分数够、各自能用；框外（放宽 15%）的点不要；两人重合的点（< 0.06 躯干）从置信度低的那个人身上去掉，
 * 重合 6 个以上算重复检测；按大小排，第三个人和第二个差不多大、超过 6 个人、两人大小差太多、太小的都不要。没有就是 null
 */
export function selectPair(persons: readonly DetectedPerson[], w: number, h: number, o: PairOptions = YOLOX_PAIR): Pair | null {
  if (persons.length < 2) return null;
  let P: { p: PairPerson; box: DetectedPerson['box'] }[] = [];
  for (const d of persons) {
    if (d.fallback || d.score < o.scoreMin) continue;
    const kp = d.kp.slice(0, NPTS).map((q) => [q[0], q[1]] as Pt);
    const ks = d.ks.slice(0, NPTS).map((s) => (s < 0 ? 0 : s > 1 ? 1 : s));
    const [x1, y1, x2, y2] = d.box;
    const mx = 0.15 * (x2 - x1);
    const my = 0.15 * (y2 - y1);
    kp.forEach(([x, y], i) => {
      if (x < x1 - mx || x > x2 + mx || y < y1 - my || y > y2 + my) ks[i] = 0;
    });
    const p = { kp, ks };
    if (ok(p, d.box, w, h, o.minPoints)) P.push({ p, box: d.box });
  }
  if (P.length < 2) return null;
  const drop = new Set<number>();
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      if (drop.has(i) || drop.has(j)) continue;
      const { kp: ki, ks: si } = P[i]!.p;
      const { kp: kj, ks: sj } = P[j]!.p;
      const t = Math.min(torso(ki, si), torso(kj, sj));
      let same = 0;
      for (let q = 0; q < 17; q++) if (si[q]! > THR && sj[q]! > THR && dist(ki[q]!, kj[q]!) < 0.06 * t) same++;
      if (same >= 6) {
        const mean = (s: number[]) => s.slice(0, 17).reduce((a, b) => a + b, 0) / 17;
        drop.add(mean(si) >= mean(sj) ? j : i);
        continue;
      }
      for (const jj of LIMBJ) {
        const d = Array.from({ length: 17 }, (_, q) => dist(kj[q]!, ki[jj]!));
        const hit = d.some((x, q) => x < 0.06 * t && sj[q]! > THR);
        if (si[jj]! > THR && hit) {
          let k2 = 0;
          for (let q = 1; q < 17; q++) if (d[q]! < d[k2]!) k2 = q;
          if (si[jj]! < sj[k2]!) si[jj] = 0;
          else sj[k2] = 0;
        }
      }
    }
  P = P.filter((_, k) => !drop.has(k));
  if (P.length < 2) return null;
  // 稳定排序，大的在前
  const sized = P.map((x) => ({ ...x, e: extent(x.p.kp, x.p.ks) })).sort((a, b) => b.e - a.e);
  const e = sized.map((x) => x.e);
  if (sized.length >= 3 && e[2]! > 0.5 * e[1]!) return null;
  if (sized.length > 6) return null;
  if (e[1]! < 0.35 * e[0]!) return null;
  if (e[1]! < 0.15 * Math.max(w, h)) return null;
  for (const x of sized.slice(0, 2)) if (!ok(x.p, x.box, w, h, 8)) return null;
  return { a: sized[0]!.p, b: sized[1]!.p, count: sized.length };
}

// ---------------------------------------------------------------- 距离

const REL_KEYS = ['sh', 'hip', 'sc', 'ta', 'tb', 'fa', 'fb', 'ca', 'cb', 'ov'] as const;
type RelKey = (typeof REL_KEYS)[number];
const REL_W: Record<RelKey, number> = { sh: 2.0, hip: 1.5, sc: 0.7, ta: 3.0, tb: 3.0, fa: 1.5, fb: 1.5, ca: 1.5, cb: 1.5, ov: 1.0 };
const W_PERSON = 0.5;

/** 两人之间的相对位置：每项一个值（向量或标量）和是否有效 */
type Rel = Record<RelKey, { x: number[]; v: number }>;

function torsoFrame(kp: readonly Pt[], ks: readonly number[]) {
  const ms = mid(kp[5]!, kp[6]!);
  if (ks[11]! > THR && ks[12]! > THR) {
    const mh = mid(kp[11]!, kp[12]!);
    return { ms, mh, t: Math.max(dist(ms, mh), 1e-3), hip: true };
  }
  const sh: Pt = [kp[6]![0] - kp[5]![0], kp[6]![1] - kp[5]![1]];
  const sw = Math.max(Math.hypot(sh[0], sh[1]), 1e-3);
  let down: Pt = [-sh[1] / sw, sh[0] / sw];
  if (down[1] < 0) down = [-down[0], -down[1]];
  return { ms, mh: [ms[0] + down[0] * sw * 1.6, ms[1] + down[1] * sw * 1.6] as Pt, t: sw * 1.6, hip: false };
}

function relOne(ka: readonly Pt[], sa: readonly number[], kb: readonly Pt[], sb: readonly number[]): Rel {
  const A = torsoFrame(ka, sa);
  const B = torsoFrame(kb, sb);
  const T = (A.t + B.t) / 2;
  const face = (k: readonly Pt[], s: readonly number[], ms: Pt) => {
    const sw = Math.max(dist(k[6]!, k[5]!), 0.2 * T);
    return { x: [Math.min(1, Math.max(-1, (k[0]![0] - ms[0]) / sw))], v: s[0]! > THR ? 1 : 0 };
  };
  const contact = (k1: readonly Pt[], s1: readonly number[], k2: readonly Pt[], s2: readonly number[]) => {
    const tg = [0, 5, 6, 11, 12].filter((j) => s2[j]! > THR).map((j) => k2[j]!);
    const ds = [9, 10].filter((w) => s1[w]! > THR).flatMap((w) => tg.map((t) => dist(k1[w]!, t) / T));
    return ds.length ? { x: [Math.min(1, Math.min(...ds) / 0.8)], v: 1 } : { x: [0], v: 0 };
  };
  const bb = (k: readonly Pt[], s: readonly number[]) => {
    const pts = k.slice(0, 17).filter((_, i) => s[i]! > THR);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return pts.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
  };
  const [ax0, ay0, ax1, ay1] = bb(ka, sa) as [number, number, number, number];
  const [bx0, by0, bx1, by1] = bb(kb, sb) as [number, number, number, number];
  const iw = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const ih = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - iw * ih;
  return {
    sh: { x: [(B.ms[0] - A.ms[0]) / T, (B.ms[1] - A.ms[1]) / T], v: 1 },
    hip: { x: [(B.mh[0] - A.mh[0]) / T, (B.mh[1] - A.mh[1]) / T], v: A.hip && B.hip ? 1 : 0 },
    sc: { x: [Math.min(1.5, Math.max(-1.5, Math.log(B.t / A.t)))], v: 1 },
    ta: { x: [(A.ms[0] - A.mh[0]) / A.t, (A.ms[1] - A.mh[1]) / A.t], v: 1 },
    tb: { x: [(B.ms[0] - B.mh[0]) / B.t, (B.ms[1] - B.mh[1]) / B.t], v: 1 },
    fa: face(ka, sa, A.ms),
    fb: face(kb, sb, B.ms),
    ca: contact(ka, sa, kb, sb),
    cb: contact(kb, sb, ka, sa),
    ov: { x: [(iw * ih) / Math.max(ua, 1e-3)], v: 1 },
  };
}

function relDist(a: Rel, b: Rel): number {
  let num = 0;
  let den = 0;
  for (const k of REL_KEYS) {
    const xa = a[k].x;
    const xb = b[k].x;
    let x: number;
    if (k === 'ta' || k === 'tb') {
      const na = Math.hypot(xa[0]!, xa[1]!) + 1e-6;
      const nb = Math.hypot(xb[0]!, xb[1]!) + 1e-6;
      const c = Math.min(1, Math.max(-1, (xa[0]! / na) * (xb[0]! / nb) + (xa[1]! / na) * (xb[1]! / nb)));
      x = Math.min(1, (Math.acos(c) * 180) / Math.PI / 50);
    } else if (k === 'sh' || k === 'hip') x = Math.min(1, Math.hypot(xa[0]! - xb[0]!, xa[1]! - xb[1]!));
    else if (k === 'sc') x = Math.min(1, Math.abs(xa[0]! - xb[0]!) / 0.7);
    else x = Math.min(1, Math.abs(xa[0]! - xb[0]!));
    const both = a[k].v * b[k].v;
    const one = Math.abs(a[k].v - b[k].v);
    const w = REL_W[k];
    num += w * both * x + w * 0.3 * one * 0.5;
    den += w * both + w * 0.3 * one;
  }
  return num / (den + 1e-6);
}

const flipx = (k: readonly Pt[]): Pt[] => k.map((p) => [-p[0], p[1]] as Pt);

/** 两人骨架的特征：每个人的姿势特征，和相对位置的 4 个变体（0 原样、1 两人对调、2 镜像、3 镜像再对调） */
export interface PairFeatures {
  A: PoseFeatures;
  B: PoseFeatures;
  rel: [Rel, Rel, Rel, Rel];
}

export function pairFeatures(a: PairPerson, b: PairPerson): PairFeatures {
  const rel: Rel[] = [];
  for (const m of [false, true]) {
    const ka = m ? flipx(a.kp) : a.kp;
    const kb = m ? flipx(b.kp) : b.kp;
    for (const sw of [false, true]) rel.push(sw ? relOne(kb, b.ks, ka, a.ks) : relOne(ka, a.ks, kb, b.ks));
  }
  return { A: poseFeatures(a.kp, a.ks), B: poseFeatures(b.kp, b.ks), rel: rel as PairFeatures['rel'] };
}

/** 图（相对位置用原样）和线稿（取最像的变体）之间的距离 */
export function pairDistance(lib: PairFeatures, ref: PairFeatures): number {
  const dAA = poseDistance(lib.A, ref.A).d;
  const dBB = poseDistance(lib.B, ref.B).d;
  const dAB = poseDistance(lib.A, ref.B).d;
  const dBA = poseDistance(lib.B, ref.A).d;
  let best = Infinity;
  for (let v = 0; v < 4; v++) {
    const dp = v === 0 || v === 2 ? (dAA + dBB) / 2 : (dAB + dBA) / 2;
    const tot = W_PERSON * dp + (1 - W_PERSON) * relDist(lib.rel[0], ref.rel[v]!);
    if (tot < best) best = tot;
  }
  return best;
}

// ---------------------------------------------------------------- 存储格式

/** 两个人存成 float32：w、h，再两人各 23 ×（x, y, 置信度），坐标按长边归一 */
export function packPair(p: Pair, w: number, h: number): Buffer {
  const m = Math.max(w, h, 1);
  const a = new Float32Array(2 + 2 * NPTS * 3);
  a[0] = w / m;
  a[1] = h / m;
  [p.a, p.b].forEach((q, k) => {
    for (let i = 0; i < NPTS; i++) {
      const o = 2 + (k * NPTS + i) * 3;
      a[o] = q.kp[i]![0] / m;
      a[o + 1] = q.kp[i]![1] / m;
      a[o + 2] = q.ks[i]!;
    }
  });
  return Buffer.from(a.buffer);
}

export function unpackPair(buf: Uint8Array): { a: PairPerson; b: PairPerson } {
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const person = (k: number): PairPerson => {
    const kp: Pt[] = [];
    const ks: number[] = [];
    for (let i = 0; i < NPTS; i++) {
      const o = 2 + (k * NPTS + i) * 3;
      kp.push([f[o]!, f[o + 1]!]);
      ks.push(f[o + 2]!);
    }
    return { kp, ks };
  };
  return { a: person(0), b: person(1) };
}
