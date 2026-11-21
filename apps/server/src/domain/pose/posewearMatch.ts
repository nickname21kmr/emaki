/**
 * 一张图匹配 PoseWear 姿势（纯函数）：原型 posewear_final/run_final.py（单人）和 pose-pair/tags_v1/run_pair.py（双人）的移植。
 *
 * 单人（主要人物 + 取景 + 标签）：
 * - 配方：标签（分数 ≥ 0.35）过了某种写法 → 强度（有几个子句靠非通用标签满足，最多 2）、标签分（各子句最高分的平均）；
 *   没过但加上低分标签（0.17–0.35）能过的 → 低置信，骨架阈值再乘 F_LOW；只按骨架的姿势（skeleton）不看标签。
 * - 骨架距离：和这个姿势每个能用的视角比，取最近的（镜像、左右标签不变）。取景决定比哪些：全身、七分身比全身姿势（视角按取景筛）
 *   和没点身体姿态的上半身姿势（双方都去掉腿）；半身、胸像只比上半身姿势；躺卧一类所有视角都比，图的骨架还转 90°、180°、270°。
 * - 阈值按强度、取景（上半身用小的）、躺卧（× 1.5）、「姿态」姿势（× 1.8，躺卧的 × 1.5）；过了阈值就算匹配上，
 *   一张图可以匹配好几个姿势。没有能用视角的姿势：强度 ≥ 1 且标签分 ≥ 0.45 按标签匹配（tag_only）。
 * - 一张图的主要姿势：按 key 排第一的（距离 / 阈值，上半身姿势在全身图上 + 0.3，低置信 + 1）。
 * 双人（两人骨架 + 标签）：标签说是两个人才看；每类里的 pair60 姿势过了配方，有两人骨架和视角的按骨架阈值，
 * 没有的强度 2 且标签分 ≥ 0.45 按标签匹配；一类里取最像的那个。
 * 名次分 score = 0.6·(1 − 距离 / 阈值) + 0.4·标签分（只按标签的骨架项按 0），低置信的不另外往后挪。
 */
import type { PoseFeatures, Pt } from './features.ts';
import { poseDistance, poseFeatures } from './features.ts';
import { pairDistance, pairFeatures, type PairFeatures, type PairPerson } from './pairs.ts';
import type { MaskMode, PairPoseAsset, PoseWearAsset, PreparedPairView, PreparedView, RecipeAlt, SinglePoseAsset } from './posewearAsset.ts';

export type PoseWearMethod = 'tags+skel' | 'skel_only' | 'lowtag+skel' | 'tag_only';

export interface PoseWearHit {
  poseId: string;
  method: PoseWearMethod;
  /** 单人、双人各自 key 最小的那个 */
  primary: boolean;
  distance: number | null;
  /** 距离 / 阈值（≤ 1 才算匹配上；只按标签的是 null） */
  distNorm: number | null;
  tagScore: number;
  /** 匹配上的视角（front、side……） */
  view: string | null;
  /** 图的骨架转了多少度才像（躺卧一类） */
  rotation: number;
  /** 一张图里排主要姿势用 */
  key: number;
  /** 一个姿势里排名次用 */
  score: number;
}

export type TagScores = ReadonlyMap<string, number>;

export interface SingleInput {
  /** 取景（full、mid、waist、bust；other 不匹配单人） */
  group: MaskMode;
  /** 主要人物（selectPerson 屏蔽过的置信度） */
  kp: readonly Pt[];
  ks: readonly number[];
  /** 分数 ≥ 0.35 的标签 */
  tags: TagScores;
  /** 低分标签（0.17 起）；没有就是 null */
  low?: TagScores | null;
}

export interface PairInput {
  tags: TagScores;
  /** 挑出的两个人（selectPair）；没有时只能按标签 */
  pair: { a: PairPerson; b: PairPerson } | null;
}

// ---------------------------------------------------------------- 配方

export const passes = (tags: TagScores, a: RecipeAlt, veto: TagScores = tags) =>
  a.all_of_any.every((g) => g.some((t) => tags.has(t))) && !a.none_of.some((t) => veto.has(t));

export function tagScore(tags: TagScores, a: RecipeAlt): number {
  if (!a.all_of_any.length) return 0;
  return a.all_of_any.reduce((s, g) => s + Math.max(...g.map((t) => tags.get(t) ?? 0)), 0) / a.all_of_any.length;
}

/** 单人的强度：有几个子句靠非通用标签满足（最多 2）；只有身体姿态的配方是 0 */
export function singleStrength(pose: SinglePoseAsset, a: RecipeAlt, tags: TagScores, generic: ReadonlySet<string>): number {
  if (pose.level !== 'tag') return 0;
  return Math.min(2, a.all_of_any.filter((g) => g.some((t) => !generic.has(t) && tags.has(t))).length);
}

/** 双人的强度：决定性的标签一个算 2，其他非通用的算 1（最多 2） */
export function pairStrength(a: RecipeAlt, tags: TagScores, generic: ReadonlySet<string>, defining: ReadonlySet<string>): number {
  let s = 0;
  for (const g of a.all_of_any) {
    const hit = g.filter((t) => tags.has(t));
    if (hit.some((t) => defining.has(t))) s += 2;
    else if (hit.some((t) => !generic.has(t))) s += 1;
  }
  return Math.min(2, s);
}

const setCache = new WeakMap<readonly string[], ReadonlySet<string>>();
const asSet = (xs: readonly string[]) => {
  let s = setCache.get(xs);
  if (!s) setCache.set(xs, (s = new Set(xs)));
  return s;
};

export function rankScore(asset: PoseWearAsset, method: PoseWearMethod, distNorm: number | null, tagScoreValue: number): number {
  const skel = method === 'tag_only' || distNorm === null ? 0 : Math.max(0, 1 - distNorm);
  return asset.params.rank.skeleton * skel + asset.params.rank.tags * tagScoreValue;
}

// ---------------------------------------------------------------- 单人

/** 图的骨架转 k × 90°（特征和平移、缩放无关） */
export function rotate(kp: readonly Pt[], k: number): Pt[] {
  if (k === 1) return kp.map(([x, y]) => [-y, x] as Pt);
  if (k === 2) return kp.map(([x, y]) => [-x, -y] as Pt);
  if (k === 3) return kp.map(([x, y]) => [y, -x] as Pt);
  return kp.map(([x, y]) => [x, y] as Pt);
}

/** 全身姿势的视角能不能和这种取景的图比（run.py 的 allowed）：坐、跪的线稿投影像站着的，不给全身、七分身的图比 */
function allowedFull(v: PreparedView, g: 'full' | 'mid'): boolean {
  if (v.standingCat) return true;
  if (g === 'full') return v.hip === null || v.hip <= 1.2;
  return v.kd !== null && v.kd <= 0.7;
}

/** 每种取景要比的视角（按资产缓存） */
interface ViewPlan {
  /** 原样比的视角 */
  plain: PreparedView[];
  /** 全身图上比上半身姿势（双方去掉腿） */
  legless: PreparedView[];
  /** 躺卧一类（图的骨架转着比） */
  lying: PreparedView[];
}
const plans = new WeakMap<PoseWearAsset, Map<MaskMode, ViewPlan>>();
function viewPlan(asset: PoseWearAsset, g: MaskMode): ViewPlan {
  let byGroup = plans.get(asset);
  if (!byGroup) plans.set(asset, (byGroup = new Map()));
  let plan = byGroup.get(g);
  if (plan) return plan;
  const pose = (v: PreparedView) => asset.singles[v.poseIndex]!;
  const skel = (v: PreparedView) => pose(v).level === 'skeleton';
  const upr = g === 'waist' || g === 'bust';
  let plain: PreparedView[];
  let legless: PreparedView[] = [];
  if (!upr) {
    const body = asset.views.filter((v) => !pose(v).upper && !pose(v).lying);
    plain = body.filter((v) => v.good && allowedFull(v, g as 'full' | 'mid'));
    // 这种取景下一个视角都不让比的姿势（拱桥、劈叉……）：全部能用的视角
    const got = new Set(plain.map((v) => v.poseIndex));
    plain = [...plain, ...body.filter((v) => !got.has(v.poseIndex))];
    legless = asset.views.filter((v) => pose(v).upper && pose(v).upperOnFull && !pose(v).lying && !skel(v));
  } else plain = asset.views.filter((v) => pose(v).upper && !pose(v).lying && (!v.armsDown || !skel(v)));
  // 躺卧：全身姿势的视角在前，半身、胸像的图再比上半身的
  const lying = [
    ...asset.views.filter((v) => pose(v).lying && !pose(v).upper),
    ...(upr ? asset.views.filter((v) => pose(v).lying && pose(v).upper) : []),
  ];
  byGroup.set(g, (plan = { plain, legless, lying }));
  return plan;
}

export function matchSingle(asset: PoseWearAsset, input: SingleInput): PoseWearHit[] {
  const P = asset.params.single;
  const generic = asSet(P.generic);
  const strict = input.tags;
  let low: Map<string, number> | null = null;
  if (input.low) {
    for (const [t, s] of input.low) if (!strict.has(t) && s >= P.lowMin) (low ??= new Map()).set(t, s);
    if (low) for (const [t, s] of strict) low.set(t, s);
  }
  const g = input.group;
  const upr = g === 'waist' || g === 'bust';
  const poses = asset.singles;
  const n = poses.length;
  const PM = new Uint8Array(n);
  const PL = new Uint8Array(n);
  const SM = new Uint8Array(n);
  const SL = new Uint8Array(n);
  const TS = new Float64Array(n);
  const TL = new Float64Array(n);
  const skel = (p: SinglePoseAsset) => p.level === 'skeleton';
  if (strict.size || low) {
    poses.forEach((p, i) => {
      if (skel(p)) return;
      const al = strict.size ? p.alts.filter((a) => passes(strict, a)) : [];
      if (al.length) {
        PM[i] = 1;
        SM[i] = Math.max(...al.map((a) => singleStrength(p, a, strict, generic)));
        TS[i] = Math.max(...al.map((a) => tagScore(strict, a)));
        return;
      }
      if (low) {
        // none_of 只看严格的标签（低分的不否决）
        const ll = p.alts.filter((a) => passes(low, a, strict));
        if (ll.length) {
          PL[i] = 1;
          SL[i] = Math.max(...ll.map((a) => singleStrength(p, a, low, generic)));
          TL[i] = Math.max(...ll.map((a) => tagScore(low, a)));
        }
      }
    });
  }
  const gate = (i: number) => PM[i] || PL[i] || skel(poses[i]!);

  // 骨架距离：每个姿势取最近的视角
  const D = new Float64Array(n).fill(Infinity);
  const BV: (string | null)[] = new Array(n).fill(null);
  const RT = new Uint8Array(n);
  const plan = viewPlan(asset, g);
  const run = (A: PoseFeatures, views: PreparedView[], mode: MaskMode, rk: number) => {
    for (const v of views) {
      const i = v.poseIndex;
      if (!gate(i)) continue;
      const d = poseDistance(A, v.feats(mode)).d;
      if (d < D[i]!) {
        D[i] = d;
        BV[i] = v.view;
        RT[i] = rk;
      }
    }
  };
  const A = poseFeatures(input.kp, input.ks);
  run(A, plan.plain, g, 0);
  // 上半身姿势在全身图上：双方都去掉腿
  if (plan.legless.some((v) => gate(v.poseIndex)))
    run(
      poseFeatures(
        input.kp,
        input.ks.map((s, j) => (j >= 13 ? 0 : s)),
      ),
      plan.legless,
      'waist',
      0,
    );
  // 躺卧一类：所有视角，图的骨架转 0 / 90 / 180 / 270°（原型按转的角度在外层，最近的取先比到的）
  if (poses.some((p, i) => p.lying && (PM[i] || PL[i]))) {
    for (let rk = 0; rk < 4; rk++) run(rk === 0 ? A : poseFeatures(rotate(input.kp, rk), input.ks), plan.lying, g, rk);
  }

  const hits: PoseWearHit[] = [];
  poses.forEach((p, i) => {
    const useUp = upr || p.upper;
    const fam = p.lying ? P.lyingFactor : 1;
    const ptf = p.posture ? (p.lying ? Math.min(P.postureFactor, P.postureFactorLying) : P.postureFactor) : 1;
    const tab = useUp ? P.thrUpper : P.thrFull;
    let thr: number;
    if (skel(p)) thr = upr ? P.thrSkeleton * P.upperFactor : P.thrSkeleton;
    else if (PM[i]) thr = tab[SM[i]!]! * fam * ptf;
    else if (PL[i]) thr = tab[SL[i]!]! * fam * ptf * P.lowFactor;
    else return;
    const dn = D[i]! / thr;
    const ok = dn <= 1;
    const main = ok && (PM[i] === 1 || skel(p));
    const isLow = ok && PL[i] === 1 && !main;
    const tagOnly = PM[i] === 1 && !p.hasView && SM[i]! >= 1 && TS[i]! >= P.tagOnlyMin;
    if (!main && !isLow && !tagOnly) return;
    const pen = !upr && p.upper ? P.upperOnFullPenalty : 0;
    const method: PoseWearMethod = main ? (skel(p) ? 'skel_only' : 'tags+skel') : isLow ? 'lowtag+skel' : 'tag_only';
    const ts = isLow ? TL[i]! : TS[i]!;
    const distNorm = method === 'tag_only' ? null : dn;
    hits.push({
      poseId: p.id,
      method,
      primary: false,
      distance: method === 'tag_only' || !Number.isFinite(D[i]!) ? null : D[i]!,
      distNorm,
      tagScore: ts,
      view: method === 'tag_only' ? null : BV[i]!,
      rotation: method === 'tag_only' ? 0 : RT[i]! * 90,
      key: method === 'tag_only' ? 2 - TS[i]! : dn + pen + (isLow ? P.lowKeyPenalty : 0),
      score: rankScore(asset, method, distNorm, ts),
    });
  });
  hits.sort((a, b) => a.key - b.key);
  if (hits[0]) hits[0].primary = true;
  return hits;
}

// ---------------------------------------------------------------- 双人

/** 标签说是两个人（数人头的标签加起来是 2，或者只有 couple），没有群交一类的标签 */
export function twoPeople(asset: PoseWearAsset, tags: TagScores): boolean {
  const P = asset.params.pair;
  if (P.exclude.some((t) => tags.has(t))) return false;
  let n = 0;
  for (const [t, c] of Object.entries(P.count)) if (tags.has(t)) n += c;
  return n === 2 || (n === 0 && tags.has(P.couple));
}

const pairViewCache = new WeakMap<PreparedPairView, PairFeatures>();
function pairViewFeatures(v: PreparedPairView): PairFeatures | null {
  if (v.points.length < 2) return null;
  let f = pairViewCache.get(v);
  if (!f) pairViewCache.set(v, (f = pairFeatures(v.points[0]!, v.points[1]!)));
  return f;
}

interface PairCand {
  type: PairPoseAsset;
  method: PoseWearMethod;
  strength: number;
  nclause: number;
  tagScore: number;
  distance: number | null;
  distNorm: number | null;
  view: string | null;
}

/** 一类里、几类之间排先后：骨架过了的在前（距离 / 阈值小的先），只靠标签的在后（强度、子句数、标签分高的先） */
function pairKey(c: PairCand): number[] {
  return c.method === 'tags+skel' ? [0, c.distNorm ?? 9] : [1, -c.strength, -c.nclause, -c.tagScore];
}
const cmpKey = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

export function matchPair(asset: PoseWearAsset, input: PairInput): PoseWearHit[] {
  const P = asset.params.pair;
  if (!twoPeople(asset, input.tags)) return [];
  const generic = asSet(P.generic);
  const defining = asSet(P.defining);
  const lib = input.pair ? pairFeatures(input.pair.a, input.pair.b) : null;
  const best: PairCand[] = [];
  for (const type of asset.pairs) {
    let top: PairCand | null = null;
    for (const m of type.members) {
      const ok = m.alts.filter((a) => passes(input.tags, a));
      if (!ok.length) continue;
      const st = Math.max(...ok.map((a) => pairStrength(a, input.tags, generic, defining)));
      const ts = Math.max(...ok.map((a) => tagScore(input.tags, a)));
      // 用来数子句的那种写法：强度、标签分最高的（同分取先写的）
      let pick = ok[0]!;
      for (const a of ok.slice(1)) {
        const k1 = [pairStrength(a, input.tags, generic, defining), tagScore(input.tags, a)];
        const k0 = [pairStrength(pick, input.tags, generic, defining), tagScore(input.tags, pick)];
        if (k1[0]! > k0[0]! || (k1[0] === k0[0] && k1[1]! > k0[1]!)) pick = a;
      }
      let c: PairCand | null = null;
      if (lib && m.hasView) {
        let d = Infinity;
        let view: string | null = null;
        for (const v of asset.pairViews) {
          if (v.pose !== m.pose) continue;
          const f = pairViewFeatures(v);
          if (!f) continue;
          const x = pairDistance(lib, f);
          if (x < d) {
            d = x;
            view = v.view;
          }
        }
        const thr = P.thr[st]!;
        // 强度 0 的原型还要求比「空姿势」更近；收的这几类强度都至少是 1
        if (Number.isFinite(d) && d < thr && st > 0)
          c = { type, method: 'tags+skel', strength: st, nclause: pick.all_of_any.length, tagScore: ts, distance: d, distNorm: d / thr, view };
      } else if (st >= 2 && ts >= P.tagOnlyMin) {
        c = { type, method: 'tag_only', strength: st, nclause: pick.all_of_any.length, tagScore: ts, distance: null, distNorm: null, view: null };
      }
      if (c && (!top || cmpKey(pairKey(c), pairKey(top)) < 0)) top = c;
    }
    if (top) best.push(top);
  }
  if (!best.length) return [];
  let primary = best[0]!;
  for (const c of best) if (cmpKey(pairKey(c), pairKey(primary)) < 0) primary = c;
  return best.map((c) => ({
    poseId: c.type.id,
    method: c.method,
    primary: c === primary,
    distance: c.distance,
    distNorm: c.distNorm,
    tagScore: c.tagScore,
    view: c.view,
    rotation: 0,
    key: c.method === 'tags+skel' ? c.distNorm! : 2 - c.tagScore,
    score: rankScore(asset, c.method, c.distNorm, c.tagScore),
  }));
}
