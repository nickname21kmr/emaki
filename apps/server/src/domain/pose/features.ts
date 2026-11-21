/**
 * 姿势的人物筛选、取景分组、特征和距离：原型 cluster.py / cluster_full.py 的移植（纯函数，没有副作用）。
 *
 * - 人物：DWPose 的前 23 个点（身体 17 + 脚 6），坐标是像素，置信度 0–1；
 * - 筛选（check）：点太少、太小、没肩膀、四肢不够、躯干错乱、肢体比例离谱、头离肩太远的不要；一张图超过 4 个像样的人（群像、分格）整张不要；
 * - 主要人物：通过筛选的人里，可见点外框面积 × 平均置信度最大的；
 * - 取景：full（髋膝踝都在）、mid（髋膝）、waist（只到腰，髋清楚）、bust（没有髋）、other；
 * - 距离：镜像不变；上半身按左右标签互换取小，腿当成无序的一对（两种配对各取小），再加髋高、最低膝下沉和每条腿的弯曲。
 * 一致率测试：domain/pose/__tests__/agreement.test.ts（原型的 400 张图）。
 */

export const THR = 0.3;
/** 膝、踝、脚低于这个的大多是猜的（腿被画面截断） */
export const LEG_THR = 0.45;
/** 只到腰的图：髋要清楚（>= 0.5 且在画面里），弱的髋大多是胸像底边猜出来的 */
export const HIP_REAL = 0.5;
export const NPTS = 23;

export type Pt = readonly [number, number];
export type Group = 'full' | 'mid' | 'waist' | 'bust' | 'other';
export const POSE_GROUPS = ['full', 'mid', 'waist', 'bust'] as const;

/** 检测到的一个人（坐标是检测时那张图的像素） */
export interface DetectedPerson {
  box: readonly [number, number, number, number];
  score: number;
  /** 没检测到人时整张图当一个框 */
  fallback: boolean;
  kp: readonly Pt[];
  ks: readonly number[];
}

export interface Person {
  kp: Pt[];
  ks: number[];
}

const clip01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const norm = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const ptp = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

function body(p: DetectedPerson): Person {
  return { kp: p.kp.slice(0, NPTS).map((q) => [q[0], q[1]] as Pt), ks: p.ks.slice(0, NPTS).map(clip01) };
}

const LIMB_BOUNDS: [number, number, number][] = [
  [5, 7, 1.6], [6, 8, 1.6], [7, 9, 1.6], [8, 10, 1.6],
  [11, 13, 2.4], [12, 14, 2.4], [13, 15, 2.4], [14, 16, 2.4],
];

/** 一个人能不能用；不能用时给原因 */
export function check(p: DetectedPerson, w: number, h: number): string | null {
  const { kp, ks } = body(p);
  const v = ks.slice(0, 17).map((s) => s > THR);
  const vis = v.flatMap((ok, i) => (ok ? [i] : []));
  if (vis.length < 8) return 'few_points';
  if (p.fallback && vis.reduce((s, i) => s + ks[i]!, 0) / vis.length < 0.5) return 'fallback_lowconf';
  const ext = Math.max(ptp(vis.map((i) => kp[i]![0])), ptp(vis.map((i) => kp[i]![1])));
  if (ext < 0.18 * Math.max(w, h)) return 'tiny';
  const sh = v[5] && v[6];
  const hp = v[11] && v[12];
  if (!sh) return 'no_shoulders';
  // 姿势要有四肢：肘、腕、膝、踝至少 3 个（腿用更严的门槛）
  const limbs = [7, 8, 9, 10].filter((i) => v[i]).length + [13, 14, 15, 16].filter((i) => ks[i]! >= LEG_THR).length;
  if (limbs < 3) return 'no_limbs';
  const sw = norm(kp[5]!, kp[6]!);
  let unit: number;
  if (hp) {
    const torso = norm(mid(kp[5]!, kp[6]!), mid(kp[11]!, kp[12]!));
    const hw = norm(kp[11]!, kp[12]!);
    if (torso < 0.25 * Math.max(sw, hw) || torso < 1e-3) return 'scrambled_torso';
    // 肩线和髋线方向相反（蝴蝶结形）
    const a = [kp[6]![0] - kp[5]![0], kp[6]![1] - kp[5]![1]];
    const b = [kp[12]![0] - kp[11]![0], kp[12]![1] - kp[11]![1]];
    if (sw > 0.15 * torso && hw > 0.15 * torso && (a[0]! * b[0]! + a[1]! * b[1]!) / (sw * hw) < -0.3) return 'crossed_torso';
    unit = torso;
  } else unit = sw * 1.6;
  if (unit < 1e-3) return 'scrambled_torso';
  for (const [a, b, hi] of LIMB_BOUNDS) if (v[a] && v[b] && norm(kp[a]!, kp[b]!) / unit > hi) return 'limb_ratio';
  if (v[0] && norm(kp[0]!, mid(kp[5]!, kp[6]!)) > 1.4 * unit) return 'head_far';
  return null;
}

export function framing(ks: readonly number[], kp: readonly Pt[], h: number): Group {
  const v = ks.map((s) => s > THR);
  const hips = (v[11] && kp[11]![1] <= h * 1.02) || (v[12] && kp[12]![1] <= h * 1.02);
  const knees = v[13] || v[14];
  const ankles = v[15] || v[16];
  if (hips && knees && ankles) return 'full';
  if (hips && knees) return 'mid';
  if (!knees && !ankles) return [11, 12].some((j) => ks[j]! >= HIP_REAL && kp[j]![1] <= h * 0.97) ? 'waist' : 'bust';
  return 'other';
}

export type Selection =
  | { ok: true; index: number; person: Person; group: Group }
  | { ok: false; reason: string };

/**
 * 一张图里挑主要人物，并按取景屏蔽不可靠的点（腿低于 LEG_THR 的置 0，胸像的髋置 0）。
 * person 的点是原样的，ks 是屏蔽之后的
 */
/** 像样的人数（不是兜底框、分数 > 0.3、至少 5 个身体点）：PoseWear 单人匹配只要 1 个人的图 */
export function countRealPersons(persons: readonly DetectedPerson[]): number {
  return persons.filter((p) => !p.fallback && p.score > 0.3 && p.ks.slice(0, 17).filter((s) => s > THR).length >= 5).length;
}

export function selectPerson(persons: readonly DetectedPerson[], w: number, h: number): Selection {
  if (countRealPersons(persons) > 4) return { ok: false, reason: 'crowd_or_panels' };
  let why = 'no_person';
  let best: { s: number; i: number } | null = null;
  persons.forEach((p, i) => {
    const r = check(p, w, h);
    if (r === null) {
      const { kp, ks } = body(p);
      const vis = [...Array(17).keys()].filter((j) => ks[j]! > THR);
      const s = (ptp(vis.map((j) => kp[j]![0])) * ptp(vis.map((j) => kp[j]![1])) + 1) * (ks.slice(0, 17).reduce((a, b) => a + b, 0) / 17);
      // Python 的 max(元组)：分数相同取下标大的
      if (!best || s > best.s || (s === best.s && i > best.i)) best = { s, i };
    } else if (why === 'no_person') why = r;
  });
  if (!best) return { ok: false, reason: why };
  const index = (best as { i: number }).i;
  const person = body(persons[index]!);
  const ks = person.ks.map((s, j) => (j >= 13 && s < LEG_THR ? 0 : s));
  const group = framing(ks, person.kp, h);
  if (group === 'bust') ks[11] = ks[12] = 0;
  return { ok: true, index, person: { kp: person.kp, ks }, group };
}

// ---------------------------------------------------------------- 特征

const MH = 100;
const MS = 101;
type Seg = readonly [number, number, number];
const USEGS: Seg[] = [[MH, MS, 1.5], [5, 6, 0.6], [MS, 0, 0.8], [5, 7, 1.0], [7, 9, 0.8], [6, 8, 1.0], [8, 10, 0.8]];
const LSEGS: Seg[] = [[11, 12, 0.6], [11, 13, 1.3], [13, 15, 1.3], [12, 14, 1.3], [14, 16, 1.3]];
const KNEE_W = 1.2;
const SCAL_SC = [1.2, 1.0];
const SCAL_W = [3.0, 1.5];

const SWAP = [...Array(NPTS).keys()];
for (const [a, b] of [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 20], [18, 21], [19, 22]] as const) {
  SWAP[a] = b;
  SWAP[b] = a;
}

interface Segs {
  D: number[][];
  L: number[];
  C: number[];
}
interface Variant {
  U: Segs;
  Lg: Segs;
  KB: [number, number];
  KC: [number, number];
}
/** 一个人的特征：4 个变体（是否水平翻转 × 是否交换左右标签；0 是原样），加两个标量（髋高、最低膝下沉） */
export interface PoseFeatures {
  v: [Variant, Variant, Variant, Variant];
  SC: [number, number];
  SV: [number, number];
}

function pointSet(kp: readonly Pt[], ks: readonly number[]) {
  const pts = new Map<number, [Pt, number]>();
  for (let i = 0; i < NPTS; i++) pts.set(i, [kp[i]!, ks[i]!]);
  const hipC = Math.min(ks[11]!, ks[12]!);
  pts.set(MH, hipC > THR ? [mid(kp[11]!, kp[12]!), hipC] : [kp[0]!, 0]);
  pts.set(MS, [mid(kp[5]!, kp[6]!), Math.min(ks[5]!, ks[6]!)]);
  const torso = pts.get(MH)![1] > THR ? norm(pts.get(MS)![0], pts.get(MH)![0]) : norm(kp[5]!, kp[6]!) * 1.6;
  return { pts, torso: Math.max(torso, 1e-3) };
}

function segs(pts: Map<number, [Pt, number]>, torso: number, SEG: Seg[]): Segs {
  const D = SEG.map(() => [0, 0]);
  const L = SEG.map(() => 1);
  const C = SEG.map(() => 0);
  SEG.forEach(([a, b], i) => {
    const [pa, ca] = pts.get(a)!;
    const [pb, cb] = pts.get(b)!;
    if (ca > THR && cb > THR) {
      const vx = pb[0] - pa[0];
      const vy = pb[1] - pa[1];
      const n = Math.hypot(vx, vy);
      if (n > 1e-3) {
        D[i] = [vx / n, vy / n];
        L[i] = n / torso;
        C[i] = Math.min(ca, cb);
      }
    }
  });
  return { D, L, C };
}

export function poseFeatures(kp: readonly Pt[], ks: readonly number[]): PoseFeatures {
  const vars: Variant[] = [];
  for (const flip of [false, true])
    for (const swap of [false, true]) {
      let k2: Pt[] = kp.map((q) => (flip ? [-q[0], q[1]] : [q[0], q[1]]) as Pt);
      let s2 = [...ks];
      if (swap) {
        k2 = SWAP.map((j) => k2[j]!);
        s2 = SWAP.map((j) => s2[j]!);
      }
      const { pts, torso } = pointSet(k2, s2);
      const KB: [number, number] = [0, 0];
      const KC: [number, number] = [0, 0];
      ([[11, 13, 15], [12, 14, 16]] as const).forEach(([hh, k, a], li) => {
        if (Math.min(s2[hh]!, s2[k]!, s2[a]!) > THR) {
          const t = [k2[k]![0] - k2[hh]![0], k2[k]![1] - k2[hh]![1]];
          const s = [k2[a]![0] - k2[k]![0], k2[a]![1] - k2[k]![1]];
          const nt = Math.hypot(t[0]!, t[1]!);
          const ns = Math.hypot(s[0]!, s[1]!);
          if (nt > 1e-3 && ns > 1e-3) {
            KB[li] = (1 - (t[0]! * s[0]! + t[1]! * s[1]!) / (nt * ns)) / 2;
            KC[li] = 1;
          }
        }
      });
      vars.push({ U: segs(pts, torso, USEGS), Lg: segs(pts, torso, LSEGS), KB, KC });
    }
  const { pts, torso } = pointSet(kp, ks);
  const SC: [number, number] = [0, 0];
  const SV: [number, number] = [0, 0];
  const [mh, mhc] = pts.get(MH)!;
  if (mhc > THR) {
    const an = [15, 16].filter((i) => ks[i]! > THR).map((i) => kp[i]![1]);
    if (an.length) {
      SC[0] = (Math.max(...an) - mh[1]) / torso;
      SV[0] = 1;
    }
    const kn = [13, 14].filter((i) => ks[i]! > THR).map((i) => kp[i]![1]);
    if (kn.length) {
      SC[1] = (Math.max(...kn) - mh[1]) / torso;
      SV[1] = 1;
    }
  }
  return { v: vars as PoseFeatures['v'], SC, SV };
}

function segPart(a: Segs, b: Segs, SEG: Seg[]): [number, number] {
  let num = 0;
  let den = 0;
  for (let s = 0; s < SEG.length; s++) {
    const W = SEG[s]![2];
    const va = a.C[s]! > 0;
    const vb = b.C[s]! > 0;
    if (va && vb) {
      const cos = a.D[s]![0]! * b.D[s]![0]! + a.D[s]![1]! * b.D[s]![1]!;
      const ld = Math.min(1, Math.abs(Math.log(a.L[s]! / b.L[s]!)));
      const d = (1 - cos) / 2 + 0.15 * ld;
      const wb = W * Math.sqrt(a.C[s]! * b.C[s]!);
      num += wb * d;
      den += wb;
    } else if (va !== vb) {
      num += W * 0.5 * 0.6;
      den += W * 0.5;
    }
  }
  return [num, den];
}

/** a（原样）和 b（取更近的翻转）之间的距离；mirror = b 翻转之后更近 */
export function poseDistance(a: PoseFeatures, b: PoseFeatures): { d: number; mirror: boolean } {
  let ns = 0;
  let ds = 0;
  for (let q = 0; q < 2; q++) {
    const both = a.SV[q]! * b.SV[q]!;
    const one = Math.abs(a.SV[q]! - b.SV[q]!);
    const d = Math.min(1, Math.abs(a.SC[q]! / SCAL_SC[q]! - b.SC[q]! / SCAL_SC[q]!));
    ns += SCAL_W[q]! * both * d + SCAL_W[q]! * 0.5 * one * 0.6;
    ds += SCAL_W[q]! * both + SCAL_W[q]! * 0.5 * one;
  }
  const a0 = a.v[0];
  let best = Infinity;
  let mirror = false;
  for (const f of [0, 1]) {
    let ub: [number, number, number] | null = null;
    let lb: [number, number, number] | null = null;
    for (const s of [0, 1]) {
      const bv = b.v[2 * f + s]!;
      const [nu, du] = segPart(a0.U, bv.U, USEGS);
      let [nl, dl] = segPart(a0.Lg, bv.Lg, LSEGS);
      for (let li = 0; li < 2; li++) {
        const kbBoth = a0.KC[li]! * bv.KC[li]!;
        const kbOne = Math.abs(a0.KC[li]! - bv.KC[li]!);
        nl += KNEE_W * kbBoth * Math.abs(a0.KB[li]! - bv.KB[li]!) + KNEE_W * 0.5 * kbOne * 0.6;
        dl += KNEE_W * kbBoth + KNEE_W * 0.5 * kbOne;
      }
      const ru = nu / (du + 1e-6);
      const rl = nl / (dl + 1e-6);
      if (!ub || ru < ub[2]) ub = [nu, du, ru];
      if (!lb || rl < lb[2]) lb = [nl, dl, rl];
    }
    const tot = (ub![0] + lb![0] + ns) / (ub![1] + lb![1] + ds + 1e-6);
    if (tot < best) {
      best = tot;
      mirror = f === 1;
    }
  }
  return { d: best, mirror };
}

// ---------------------------------------------------------------- 归类

export interface ClassRef {
  id: string;
  group: string;
  cut: number;
  features: PoseFeatures;
}

export type Assignment = {
  status: string;
  group: Group | null;
  person: Person | null;
  classId: string | null;
  nearestId: string | null;
  distance: number | null;
  mirror: boolean;
};

/** 一张图：挑主要人物、分取景、找同组里最近的代表骨架；超出那一类范围的不归类（nearestId 还记着） */
export function assignImage(persons: readonly DetectedPerson[], w: number, h: number, classes: readonly ClassRef[]): Assignment {
  const sel = selectPerson(persons, w, h);
  if (!sel.ok) return { status: sel.reason, group: null, person: null, classId: null, nearestId: null, distance: null, mirror: false };
  return { ...assignPerson(sel.person, sel.group, classes), person: sel.person, group: sel.group };
}

export function assignPerson(person: Person, group: Group, classes: readonly ClassRef[]) {
  const out = { status: 'ok', classId: null as string | null, nearestId: null as string | null, distance: null as number | null, mirror: false };
  if (group === 'other') return { ...out, status: 'group_other' };
  const f = poseFeatures(person.kp, person.ks);
  let best: { c: ClassRef; d: number; mirror: boolean } | null = null;
  for (const c of classes) {
    if (c.group !== group) continue;
    const r = poseDistance(f, c.features);
    if (!best || r.d < best.d) best = { c, ...r };
  }
  if (!best) return { ...out, status: 'no_class' };
  return { ...out, nearestId: best.c.id, distance: best.d, mirror: best.mirror, classId: best.d <= best.c.cut ? best.c.id : null, status: best.d <= best.c.cut ? 'ok' : 'outlier' };
}

// ---------------------------------------------------------------- 存储格式

/** 主要人物存成 float32：w、h，再 23 ×（x, y, 置信度），坐标按长边归一（距离和筛选都与尺度无关） */
export function packPerson(person: Person, w: number, h: number): Buffer {
  const m = Math.max(w, h, 1);
  const a = new Float32Array(2 + NPTS * 3);
  a[0] = w / m;
  a[1] = h / m;
  for (let i = 0; i < NPTS; i++) {
    a[2 + i * 3] = person.kp[i]![0] / m;
    a[3 + i * 3] = person.kp[i]![1] / m;
    a[4 + i * 3] = person.ks[i]!;
  }
  return Buffer.from(a.buffer);
}

export function unpackPerson(buf: Uint8Array): { person: Person; w: number; h: number } {
  const a = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const kp: Pt[] = [];
  const ks: number[] = [];
  for (let i = 0; i < NPTS; i++) {
    kp.push([a[2 + i * 3]!, a[3 + i * 3]!]);
    ks.push(a[4 + i * 3]!);
  }
  return { person: { kp, ks }, w: a[0]!, h: a[1]! };
}

/** 代表骨架：float32 23 ×（x, y, 置信度），原样像素坐标 */
export function packMedoid(kp: readonly Pt[], ks: readonly number[]): Buffer {
  const a = new Float32Array(NPTS * 3);
  for (let i = 0; i < NPTS; i++) {
    a[i * 3] = kp[i]![0];
    a[i * 3 + 1] = kp[i]![1];
    a[i * 3 + 2] = ks[i]!;
  }
  return Buffer.from(a.buffer);
}

export function unpackMedoid(buf: Uint8Array): Person {
  const a = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const kp: Pt[] = [];
  const ks: number[] = [];
  for (let i = 0; i < NPTS; i++) {
    kp.push([a[i * 3]!, a[i * 3 + 1]!]);
    ks.push(a[i * 3 + 2]!);
  }
  return { kp, ks };
}
