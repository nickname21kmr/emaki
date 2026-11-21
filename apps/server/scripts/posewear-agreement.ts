/**
 * PoseWear 匹配的 TypeScript 版和原型对一致率（开发用，读原型的文件和一份图库数据库的副本，只读）：
 *   npx tsx apps/server/scripts/posewear-agreement.ts --db <emaki.sqlite 副本> [--n 1000] [--fixture <输出的小样本 json>]
 * 单人：原型 cache/keypoints_lib.npz（检测结果）按 Emaki 的规则挑主要人物、存成归一的 float32（和库里一样），标签从数据库读（≥ 0.35），
 * 低分标签读 out/posewear_v2/pose_tags_lowthr.npz；和 posewear_final/assignments_multi_weighted.json 比（图, 姿势）、主要姿势、名次分。
 * 双人：同一份检测结果按 lib_pairs.py 挑两个人，和原型的 cache/lib_pairs.npz、cache/match.npz 的距离、tags_v1/assignments.json 比。
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAIR_TYPES } from '@emaki/shared';
import { countRealPersons, packPerson, selectPerson, unpackPerson, type DetectedPerson, type Group, type Pt } from '../src/domain/pose/features.ts';
import { pairDistance, pairFeatures, packPair, selectPair, unpackPair } from '../src/domain/pose/pairs.ts';
import { loadPoseWearAsset } from '../src/domain/pose/posewearAsset.ts';
import { matchPair, matchSingle, type PoseWearHit } from '../src/domain/pose/posewearMatch.ts';
import { readNpz, type NpyArray } from '../src/infra/npz.ts';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PROTO = arg('proto', 'F:/Claude/.work/pose-proto')!;
const PAIR = arg('pair', 'F:/Claude/.work/pose-pair')!;
const DB = arg('db');
const N = Number(arg('n', '1000'));
const FIXTURE = arg('fixture');
if (!DB) throw new Error('要 --db（图库数据库的副本）');

const asset = loadPoseWearAsset();
const t0 = performance.now();
const say = (...x: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...x);

// ---------------------------------------------------------------- 检测结果
const Z = readNpz(readFileSync(path.join(PROTO, 'cache/keypoints_lib.npz')));
const A = Object.fromEntries(['img_id', 'img_w', 'img_h', 'img_err', 'img_start', 'img_count', 'p_box', 'p_score', 'p_fallback', 'p_kp', 'p_ks'].map((k) => [k, Z.get(k)!])) as Record<string, NpyArray>;
const num = (a: NpyArray, i: number) => Number(a.data[i]!);
const nkp = A.p_kp!.shape[1]!;
const row = new Map<number, number>();
for (let i = 0; i < A.img_id!.data.length; i++) row.set(num(A.img_id!, i), i);
function persons(n: number): DetectedPerson[] {
  const s = num(A.img_start!, n);
  const out: DetectedPerson[] = [];
  for (let j = s; j < s + num(A.img_count!, n); j++) {
    const kp: Pt[] = [];
    const ks: number[] = [];
    for (let k = 0; k < 23; k++) {
      kp.push([Number(A.p_kp!.data[(j * nkp + k) * 2]), Number(A.p_kp!.data[(j * nkp + k) * 2 + 1])]);
      ks.push(Number(A.p_ks!.data[j * nkp + k]));
    }
    out.push({ box: [0, 1, 2, 3].map((q) => Number(A.p_box!.data[j * 4 + q])) as [number, number, number, number], score: num(A.p_score!, j), fallback: !!A.p_fallback!.data[j], kp, ks });
  }
  return out;
}
say('keypoints', row.size);

// 原型的单人范围：full_persons.npz 里 npers == 1、取景在四组里的
const FP = readNpz(readFileSync(path.join(PROTO, 'cache/full_persons.npz')));
const fpId = FP.get('id')!;
const fpN = FP.get('npers')!;
const fpGroup = FP.get('group')!.strings!;
const population: number[] = [];
const protoGroup = new Map<number, string>();
for (let i = 0; i < fpId.data.length; i++) {
  if (num(fpN, i) !== 1 || !['full', 'mid', 'waist', 'bust'].includes(fpGroup[i]!)) continue;
  population.push(num(fpId, i));
  protoGroup.set(num(fpId, i), fpGroup[i]!);
}
say('single population', population.length);

interface ProtoPose {
  pose_id: string;
  method: string;
  primary: boolean;
  score: number;
  rank: number;
  dist_norm: number | null;
  tag_score: number;
}
const proto = JSON.parse(readFileSync(path.join(PROTO, 'out/posewear_final/assignments_multi_weighted.json'), 'utf8')) as Record<string, { framing: string; poses: ProtoPose[] }>;

// 固定的样本：随机 N·0.7 + 有匹配的 N·0.3（种子固定）
let seed = 20261121;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
const pick = <T>(xs: T[], k: number) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
};
const assigned = population.filter((id) => proto[String(id)]);
const sample = [...new Set([...pick(population, Math.round(N * 0.7)), ...pick(assigned, Math.round(N * 0.3))])].sort((a, b) => a - b);

// ---------------------------------------------------------------- 标签
const db = new Database(DB, { readonly: true, fileMustExist: true });
function tagsOf(ids: number[]): Map<number, Map<string, number>> {
  const out = new Map(ids.map((id) => [id, new Map<string, number>()]));
  const st = db.prepare('SELECT it.image_id AS id, t.name, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.score >= 0.35 AND it.image_id IN (SELECT value FROM json_each(?))');
  for (let i = 0; i < ids.length; i += 900)
    for (const r of st.all(JSON.stringify(ids.slice(i, i + 900))) as { id: number; name: string; score: number }[]) out.get(r.id)!.set(r.name, r.score);
  return out;
}
const L = readNpz(readFileSync(path.join(PROTO, 'out/posewear_v2/pose_tags_lowthr.npz')));
const lowNames = L.get('tags')!.strings!;
const lowScores = L.get('scores')!;
const lowRow = new Map<number, number>();
L.get('ids')!.data.forEach((v, k) => lowRow.set(Number(v), k));
function lowOf(id: number): Map<string, number> | null {
  const k = lowRow.get(id);
  if (k === undefined) return null;
  const m = new Map<string, number>();
  lowNames.forEach((t, j) => {
    const s = Number(lowScores.data[k * lowNames.length + j]);
    if (s >= 0.17) m.set(t, s);
  });
  return m;
}

// ---------------------------------------------------------------- 单人
const tags = tagsOf(sample);
type Fx = { id: number; group: Group; kp: number[]; ks: number[]; tags: Record<string, number>; low: Record<string, number> | null; expect: { pose: string; method: string; primary: boolean; score: number }[] };
const fixture: Fx[] = [];
const mine = new Map<number, PoseWearHit[]>();
let groupSame = 0;
let tMatch = 0;
for (const id of sample) {
  const n = row.get(id)!;
  const w = num(A.img_w!, n);
  const h = num(A.img_h!, n);
  const ps = persons(n);
  const sel = selectPerson(ps, w, h);
  if (!sel.ok || countRealPersons(ps) !== 1) {
    mine.set(id, []);
    continue;
  }
  if (sel.group === protoGroup.get(id)) groupSame++;
  // 和库里一样：按长边归一的 float32
  const { person } = unpackPerson(packPerson(sel.person, w, h));
  const t1 = performance.now();
  const hits = sel.group === 'other' ? [] : matchSingle(asset, { group: sel.group, kp: person.kp, ks: person.ks, tags: tags.get(id)!, low: lowOf(id) });
  tMatch += performance.now() - t1;
  mine.set(id, hits);
  if (FIXTURE && fixture.length < 200 && sel.group !== 'other') {
    const used = new Set(asset.singles.flatMap((p) => p.alts.flatMap((a) => [...a.all_of_any.flat(), ...a.none_of])));
    const keep = (m: Map<string, number> | null) => (m ? Object.fromEntries([...m].filter(([t]) => used.has(t)).map(([t, s]) => [t, Math.round(s * 1e4) / 1e4])) : null);
    fixture.push({
      id,
      group: sel.group,
      kp: person.kp.flatMap(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]),
      ks: person.ks.map((s) => Math.round(s * 1e4) / 1e4),
      tags: keep(tags.get(id)!)!,
      low: keep(lowOf(id)),
      expect: (proto[String(id)]?.poses ?? []).map((p) => ({ pose: p.pose_id, method: p.method, primary: p.primary, score: p.score })),
    });
  }
}
let P = 0;
let E = 0;
let both = 0;
let primSame = 0;
let primBoth = 0;
let methSame = 0;
const diffs: number[] = [];
const pairsScore: { pose: string; a: number; b: number }[] = [];
const missed: string[] = [];
const extra: string[] = [];
for (const id of sample) {
  const pp = proto[String(id)]?.poses ?? [];
  const mm = mine.get(id) ?? [];
  P += pp.length;
  E += mm.length;
  const byPose = new Map(mm.map((h) => [h.poseId, h]));
  for (const p of pp) {
    const h = byPose.get(p.pose_id);
    if (!h) {
      missed.push(`${id}:${p.pose_id}:${p.method}:${p.dist_norm}`);
      continue;
    }
    both++;
    if (h.method === p.method) methSame++;
    diffs.push(Math.abs(h.score - p.score));
    pairsScore.push({ pose: p.pose_id, a: p.score, b: h.score });
  }
  for (const h of mm) if (!pp.some((p) => p.pose_id === h.poseId)) extra.push(`${id}:${h.poseId}:${h.method}:${h.distNorm?.toFixed(3)}`);
  if (pp.length && mm.length) {
    primBoth++;
    if (pp.find((p) => p.primary)?.pose_id === mm.find((h) => h.primary)?.poseId) primSame++;
  }
}
const rankOf = (xs: number[]) => {
  const o = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  o.forEach(([, i], k) => (r[i] = k));
  return r;
};
const spearman = (a: number[], b: number[]) => {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const n = a.length;
  const ma = (n - 1) / 2;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (ra[i]! - ma) * (rb[i]! - ma);
    saa += (ra[i]! - ma) ** 2;
    sbb += (rb[i]! - ma) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};
const perPose = new Map<string, { a: number[]; b: number[] }>();
for (const x of pairsScore) {
  const e = perPose.get(x.pose) ?? { a: [], b: [] };
  e.a.push(x.a);
  e.b.push(x.b);
  perPose.set(x.pose, e);
}
const rhos = [...perPose.values()].filter((e) => e.a.length >= 5).map((e) => spearman(e.a, e.b));
const single = {
  images: sample.length,
  selectedGroupSameAsProto: groupSame,
  protoPairs: P,
  mine: E,
  both,
  jaccard: +(both / (P + E - both)).toFixed(4),
  recall: +(both / P).toFixed(4),
  precision: +(both / E).toFixed(4),
  primarySame: `${primSame}/${primBoth}`,
  methodSame: `${methSame}/${both}`,
  scoreAbsDiffMean: +(diffs.reduce((s, x) => s + x, 0) / diffs.length).toFixed(5),
  scoreAbsDiffMax: +Math.max(...diffs).toFixed(5),
  spearmanAll: +spearman(pairsScore.map((x) => x.a), pairsScore.map((x) => x.b)).toFixed(4),
  spearmanPerPoseMean: rhos.length ? +(rhos.reduce((s, x) => s + x, 0) / rhos.length).toFixed(4) : null,
  posesWith5: rhos.length,
  msPerImage: +(tMatch / sample.length).toFixed(3),
};
say('single', single);
console.log('missed', missed.slice(0, 15));
console.log('extra', extra.slice(0, 15));

// ---------------------------------------------------------------- 双人
const LP = readNpz(readFileSync(path.join(PAIR, 'cache/lib_pairs.npz')));
const lpIds = [...LP.get('id')!.data].map(Number);
const lpKs = LP.get('ks')!;
const lpSet = new Set(lpIds);
// 1. 挑两个人：在有 ≥2 个检测的图里和原型比
let selSame = 0;
let selMine = 0;
let ksDiff = 0;
let checked = 0;
const pairById = new Map<number, ReturnType<typeof selectPair>>();
for (const [id, n] of row) {
  if (num(A.img_err!, n) || num(A.img_count!, n) < 2) continue;
  const p = selectPair(persons(n), num(A.img_w!, n), num(A.img_h!, n));
  if (p) {
    selMine++;
    pairById.set(id, p);
    if (lpSet.has(id)) {
      selSame++;
      const k = lpIds.indexOf(id);
      for (let q = 0; q < 23; q++) ksDiff = Math.max(ksDiff, Math.abs(p.a.ks[q]! - Number(lpKs.data[k * 46 + q])), Math.abs(p.b.ks[q]! - Number(lpKs.data[k * 46 + 23 + q])));
      checked++;
    }
  }
}
say('pair selection', { proto: lpIds.length, mine: selMine, same: selSame, maxKsDiff: ksDiff.toFixed(4) });

// 2. 距离：原型 cache/match.npz 的 DPose（lib 来源）
const M = readNpz(readFileSync(path.join(PAIR, 'cache/match.npz')));
const mIds = [...M.get('id')!.data].map(Number);
const mSrc = M.get('src')!.strings!;
const mPoses = M.get('poses')!.strings!;
const DPose = M.get('DPose')!;
const memberPoses = [...new Set(PAIR_TYPES.flatMap((t) => t.members))].filter((m) => asset.pairViews.some((v) => v.pose === m));
let dn = 0;
let dmax = 0;
for (let r = 0; r < mIds.length; r++) {
  if (mSrc[r] !== 'lib') continue;
  const p = pairById.get(mIds[r]!);
  if (!p) continue;
  const w = num(A.img_w!, row.get(mIds[r]!)!);
  const h = num(A.img_h!, row.get(mIds[r]!)!);
  const u = unpackPair(packPair(p, w, h));
  const lf = pairFeatures(u.a, u.b);
  for (const m of memberPoses) {
    const j = mPoses.indexOf(`pair60_${m}`);
    let d = Infinity;
    for (const v of asset.pairViews) if (v.pose === m) d = Math.min(d, pairDistance(lf, pairFeatures(v.points[0]!, v.points[1]!)));
    dmax = Math.max(dmax, Math.abs(d - Number(DPose.data[r * mPoses.length + j])));
    dn++;
  }
}
say('pair distance vs proto DPose', { compared: dn, maxAbsDiff: dmax.toFixed(5) });

// 3. 匹配：原型 assignments.json 里 top3 过了阈值的（按类型并好）；只比原型骨架来自 lib 或没有骨架的图
const PA = JSON.parse(readFileSync(path.join(PAIR, 'tags_v1/assignments.json'), 'utf8')) as Record<string, { skeleton: string | null; top3: { pose: string; accepted: boolean }[] }>;
const typeOf = new Map<string, string>(PAIR_TYPES.flatMap((t) => t.members.map((m) => [`pair60_${m}`, `pair_${t.rep}`] as const)));
const pairIds = Object.keys(PA).map(Number).filter((id) => PA[String(id)]!.skeleton === null || PA[String(id)]!.skeleton === 'lib');
const ptags = tagsOf(pairIds);
let pp = 0;
let pm = 0;
let pb = 0;
for (const id of pairIds) {
  const a = PA[String(id)]!;
  const want = new Set(a.top3.filter((c) => c.accepted && typeOf.has(c.pose)).map((c) => typeOf.get(c.pose)!));
  const n = row.get(id);
  const p = a.skeleton === 'lib' ? pairById.get(id) : undefined;
  const u = p && n !== undefined ? unpackPair(packPair(p, num(A.img_w!, n), num(A.img_h!, n))) : null;
  const got = new Set(matchPair(asset, { tags: ptags.get(id)!, pair: u }).map((h) => h.poseId));
  pp += want.size;
  pm += got.size;
  for (const x of want) if (got.has(x)) pb++;
}
say('pair membership', { images: pairIds.length, proto: pp, mine: pm, both: pb, jaccard: +(pb / (pp + pm - pb)).toFixed(4) });

if (FIXTURE) {
  writeFileSync(FIXTURE, `${JSON.stringify({ note: '原型 posewear_final 的输入和结果（scripts/posewear-agreement.ts 生成）', images: fixture })}\n`);
  say('fixture', FIXTURE, fixture.length);
}
db.close();
