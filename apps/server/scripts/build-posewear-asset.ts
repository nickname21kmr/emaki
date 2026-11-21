/**
 * 生成 PoseWear 姿势库的随包数据（apps/server/assets/pose/posewear/）：只有数据，不含任何 PoseWear 的图。
 *   npx tsx apps/server/scripts/build-posewear-asset.ts [原型目录] [双人原型目录]
 * 读原型（默认 F:/Claude/.work/pose-proto、F:/Claude/.work/pose-pair）：
 * - 单人：refs/poses.json（PoseWear 的姿势列表：编号、中文名、分类、视角）、out/recipe_audit/recipes_audited.json（标签配方）、
 *   out/posewear_final/poses.json（代表视角）、cache/kp/refs/*.json（每个视角线稿上检测出的骨架）、
 *   out/preview_posewear_single/bad_views.json（看过、不能用的视角）；能用的规则照 run_v1.py / run_final.py。
 * - 双人：tags_v1/recipes.json（pair60 的配方）、cache/refs_kp2.json + refs_bad.json（两个人的骨架）；只收 PAIR_TYPES 里的几类。
 * 匹配用的参数照 run_final.py、run_pair.py。改了配方、参数或骨架要把 VERSION 加 1：图库会自动重新匹配一遍。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAIR_ADULT_CATEGORY, PAIR_TYPES } from '@emaki/shared';
import { check, NPTS, poseFeatures, THR, type Pt } from '../src/domain/pose/features.ts';

const VERSION = 1;
const PROTO = process.argv[2] ?? 'F:/Claude/.work/pose-proto';
const PAIR = process.argv[3] ?? 'F:/Claude/.work/pose-pair';
const OUT = path.resolve(import.meta.dirname, '../assets/pose/posewear');

const json = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

interface Alt {
  all_of_any: string[][];
  none_of: string[];
}
interface Recipe {
  zh: string;
  level: 'tag' | 'posture' | 'skeleton';
  alts: Alt[];
}
interface ListPose {
  id: string;
  no: string;
  zh: string;
  cat?: string;
  angles: { i: string }[];
}
interface RefFile {
  w: number;
  h: number;
  persons: { box: number[]; score: number; kp: number[][]; ks: number[]; fallback?: boolean }[];
}

const SETS = ['full_single', 'full_sexy', 'upper80v2'];
const VIEW_RE = /_(front|high|low|side|diag)$/;

// ---- 单人：run_v1.py 的常量
const RESCUE = new Set([
  'full_single_P049_side', 'full_single_P050_side', 'full_single_P057_front', 'full_single_P057_side', 'full_single_P057_diag',
  'full_single_P059_side', 'full_sexy_P046_low', 'full_sexy_P049_front', 'full_sexy_P049_side', 'full_sexy_P050_high', 'full_sexy_P050_side',
  'full_sexy_P052_low', 'full_sexy_P053_front', 'full_sexy_P053_side', 'full_sexy_P053_diag', 'full_sexy_P056_front', 'full_sexy_P057_front',
  'full_sexy_P057_low', 'full_sexy_P057_diag', 'full_sexy_P060_side', 'full_sexy_P072_side', 'full_sexy_P074_front', 'full_sexy_P074_low',
  'full_sexy_P074_diag', 'upper80v2_P034_side', 'upper80v2_P034_diag',
  // run_final.py 的 RESCUE2
  'full_single_P054_side',
]);
const GENERIC = ['standing', 'sitting', 'kneeling', 'lying', 'squatting', 'on_back', 'on_stomach', 'on_side', 'wariza', 'yokozuwari', 'seiza',
  'all_fours', 'on_one_knee', 'leaning_forward', 'bent_over', 'reclining', 'leaning_back', 'from_above', 'from_behind', 'from_side',
  'looking_at_viewer', 'looking_up', 'cleavage', 'ass', 'bed', 'on_bed', 'bed_sheet', 'wet', 'nude', 'topless', 'bra', 'undressing', 'hand_up',
  'arm_support', 'straddling', 'breasts_out'];
const LYING_TAGS = new Set(['lying', 'on_back', 'on_stomach', 'on_side']);
/** 上半身的姿势里，配方点了身体姿态的不在全身图上比 */
const POSTURE = new Set(['sitting', 'kneeling', 'all_fours', 'squatting', 'lying', 'on_back', 'on_stomach', 'on_side', 'seiza', 'wariza',
  'yokozuwari', 'top-down_bottom-up', 'leaning_forward', 'bent_over', 'straddling']);
/** run_final.py 的 ARM_WORDS：名字里有手、臂这些细节的是「细节」姿势，其余是「姿态」姿势（阈值放宽） */
const ARM_WORDS = ['手', '臂', '指', '撩发', '腮', '抱头', '掩', '捂', '挤胸', '托', '揉', '抱胸', '握', '捧', '抚', '比心', '飞吻', '敬礼', '爪', '剪刀', '耳', '肩带'];
const STAND_CATS = new Set(['站姿', '前倾', '后仰', '扭身']);

// ---- 双人：run_pair.py 的常量
const PAIR_GENERIC = ['standing', 'sitting', 'kneeling', 'lying', 'on_back', 'on_stomach', 'on_side', 'all_fours', 'squatting', 'bent_over',
  'leaning_forward', 'leaning_back', 'arm_support', 'arm_up', 'arms_up', 'knee_up', 'knees_up', 'crossed_legs', 'indian_style', 'spread_legs',
  'legs_apart', 'legs_up', 'leg_up', 'leg_lift', 'standing_on_one_leg', 'looking_at_another', 'eye_contact', 'face-to-face', 'sex', 'from_behind',
  'outstretched_arm', 'outstretched_arms', 'reaching', 'head_rest', 'hands_on_own_cheeks', 'hands_on_own_face', 'sleeping', 'tiptoes', 'foot_up',
  'arched_back', 'upside-down', 'knees_to_chest', 'handstand', 'hands_on_ground', 'against_wall', 'sitting_sideways'];
const DEFINING = ['princess_carry', '69', 'sitting_on_face', 'reverse_cowgirl_position', 'cowgirl_position', 'mating_press', 'spooning',
  'upright_straddle', 'reverse_upright_straddle', 'squatting_cowgirl_position', 'tribadism', 'whispering', 'licking_ear', 'hug_from_behind',
  'grabbing_from_behind'];
const COUNT: Record<string, number> = { '1girl': 1, '2girls': 2, '3girls': 3, '4girls': 4, '5girls': 5, '6+girls': 6, '1boy': 1, '2boys': 2,
  '3boys': 3, '4boys': 4, '5boys': 5, '6+boys': 6, '1other': 1, '2others': 2, '3others': 3, multiple_others: 3 };
const EXCL_BASE = ['group_sex', 'threesome', 'girl_sandwich', 'boy_sandwich'];

const clip01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 一个人：前 23 个点，按长边归一 */
function norm23(kp: number[][], ks: number[], w: number, h: number) {
  const m = Math.max(w, h);
  return {
    kp: kp.slice(0, NPTS).flatMap(([x, y]) => [r4(x! / m), r4(y! / m)]),
    ks: ks.slice(0, NPTS).map((s) => r4(clip01(s))),
  };
}

/** run.py 的 arms_down：上臂、前臂都在竖直向下 35° 以内（或看不见） */
function armsDown(kp: readonly Pt[], ks: readonly number[]): boolean {
  for (const [a, b] of [[5, 7], [7, 9], [6, 8], [8, 10]] as const) {
    if (ks[a]! > THR && ks[b]! > THR) {
      const vx = kp[b]![0] - kp[a]![0];
      const vy = kp[b]![1] - kp[a]![1];
      const n = Math.hypot(vx, vy);
      if (n > 1e-3 && vy / n < Math.cos((35 * Math.PI) / 180)) return false;
    }
  }
  return true;
}

function main() {
  const list = json<ListPose[]>(path.join(PROTO, 'refs/poses.json'));
  const rec = json<Record<string, Recipe>>(path.join(PROTO, 'out/recipe_audit/recipes_audited.json'));
  const finalPoses = json<Record<string, { best_view: string | null; category?: string }>>(path.join(PROTO, 'out/posewear_final/poses.json'));
  const bad = new Set(json<string[]>(path.join(PROTO, 'out/preview_posewear_single/bad_views.json')));

  const poses: unknown[] = [];
  const views: unknown[] = [];
  list.forEach((p, sort) => {
    const set = p.id.slice(0, p.id.lastIndexOf('_'));
    if (!SETS.includes(set)) return;
    const r = rec[p.id];
    if (!r) throw new Error(`${p.id} 没有配方`);
    const upper = set === 'upper80v2';
    const tags = new Set(r.alts.flatMap((a) => a.all_of_any.flat()));
    const lying = [...tags].some((t) => LYING_TAGS.has(t)) || /[躺卧趴]/.test(r.zh);
    const posture = !upper && !ARM_WORDS.some((w) => r.zh.includes(w));
    const upperOnFull = upper && ![...tags].some((t) => POSTURE.has(t));
    const viewNames: string[] = [];
    let usableAny = false;
    for (const a of p.angles) {
      const name = path.basename(a.i).replace(/\.webp$/, '');
      const view = VIEW_RE.exec(name)?.[1];
      if (!view) continue;
      viewNames.push(view);
      let f: RefFile;
      try {
        f = json<RefFile>(path.join(PROTO, 'cache/kp/refs', `${name}.json`));
      } catch {
        continue;
      }
      const q = f.persons[0];
      if (!q) continue;
      const kp = q.kp.slice(0, NPTS).map(([x, y]) => [x!, y!] as Pt);
      const ks = q.ks.slice(0, NPTS).map(clip01);
      const nv = ks.slice(0, 17).filter((s) => s > THR).length;
      const ok = check({ box: q.box as [number, number, number, number], score: q.score, fallback: !!q.fallback, kp, ks }, f.w, f.h) === null;
      const good = ok && nv >= (upper ? 8 : 11) && !bad.has(name);
      const usable = good || RESCUE.has(name);
      usableAny ||= usable;
      const feats = poseFeatures(kp, ks);
      views.push({
        pose: p.id,
        view,
        ...norm23(q.kp, q.ks, f.w, f.h),
        w: r4(f.w / Math.max(f.w, f.h)),
        h: r4(f.h / Math.max(f.w, f.h)),
        nv,
        good,
        usable,
        armsDown: armsDown(kp, ks),
        hip: feats.SV[0] ? r4(feats.SC[0]) : null,
        kd: feats.SV[1] ? r4(feats.SC[1]) : null,
        standingCat: STAND_CATS.has(p.cat ?? ''),
      });
    }
    const bv = finalPoses[p.id]?.best_view ?? null;
    poses.push({
      id: p.id,
      set,
      number: p.no,
      name: p.zh,
      category: p.cat ?? '',
      sort,
      adult: false,
      views: viewNames,
      bestView: bv ? bv.slice(p.id.length + 1) : viewNames.includes('front') ? 'front' : (viewNames[0] ?? 'front'),
      level: r.level,
      alts: r.alts,
      lying,
      posture,
      upper,
      upperOnFull,
      hasView: usableAny,
    });
  });

  // ---- 双人
  const pairRec = json<Record<string, { alts: Alt[] }>>(path.join(PAIR, 'tags_v1/recipes.json'));
  const pairKp = json<Record<string, { w: number; h: number; persons?: { kp: number[][]; ks: number[] }[] }>>(path.join(PAIR, 'cache/refs_kp2.json'));
  const pairBad = json<Record<string, unknown>>(path.join(PAIR, 'cache/refs_bad.json'));
  const pairViews: unknown[] = [];
  const pairList = list.filter((p) => p.id.startsWith('pair60_'));
  PAIR_TYPES.forEach((t, k) => {
    const members = t.members.map((m) => {
      const id = `pair60_${m}`;
      const r = pairRec[id];
      if (!r) throw new Error(`${id} 没有配方`);
      const keys = Object.keys(pairKp)
        .filter((key) => key.startsWith(`${id}_`) && pairKp[key]!.persons && !(key in pairBad))
        .sort();
      for (const key of keys) {
        const f = pairKp[key]!;
        pairViews.push({
          pose: m,
          view: VIEW_RE.exec(key)![1],
          w: r4(f.w / Math.max(f.w, f.h)),
          h: r4(f.h / Math.max(f.w, f.h)),
          persons: f.persons!.slice(0, 2).map((q) => norm23(q.kp, q.ks, f.w, f.h)),
        });
      }
      return { pose: m, alts: r.alts, hasView: keys.length > 0 };
    });
    const src = pairList.find((p) => p.no === t.rep);
    const viewNames = (src?.angles ?? []).map((a) => VIEW_RE.exec(path.basename(a.i).replace(/\.webp$/, ''))?.[1]).filter((v): v is string => !!v);
    const repViews = (pairViews as { pose: string; view: string }[]).filter((v) => v.pose === t.rep).map((v) => v.view);
    const bestView = repViews.includes('front') ? 'front' : (repViews[0] ?? (viewNames.includes('front') ? 'front' : (viewNames[0] ?? 'front')));
    poses.push({
      id: `pair_${t.rep}`,
      set: 'pair',
      number: t.rep,
      name: t.name,
      category: t.adult ? PAIR_ADULT_CATEGORY : '双人',
      sort: 100_000 + k,
      adult: t.adult,
      views: viewNames,
      bestView,
      members,
    });
  });

  const params = {
    single: {
      tagMin: 0.35,
      lowMin: 0.17,
      thrFull: [0.16, 0.24, 0.3],
      thrUpper: [0.1, 0.16, 0.2],
      thrSkeleton: 0.08,
      upperFactor: 0.5,
      lyingFactor: 1.5,
      postureFactor: 1.8,
      postureFactorLying: 1.5,
      lowFactor: 0.45,
      lowKeyPenalty: 1.0,
      upperOnFullPenalty: 0.3,
      tagOnlyMin: 0.45,
      generic: GENERIC,
    },
    pair: { thr: [0.3, 0.4, 0.48], tagOnlyMin: 0.45, generic: PAIR_GENERIC, defining: DEFINING, count: COUNT, exclude: EXCL_BASE, couple: 'couple' },
    rank: { skeleton: 0.6, tags: 0.4 },
  };
  const note = 'PoseWear（MIT）姿势目录的编号、中文名、分类；匹配配方、参数和骨架由 Emaki 的原型算出。不含任何线稿图片。';
  writeFileSync(path.join(OUT, 'catalog.json'), `${JSON.stringify({ version: VERSION, note, params, poses }, null, 1)}\n`);
  writeFileSync(path.join(OUT, 'skeletons.json'), `${JSON.stringify({ version: VERSION, views, pairViews })}\n`);
  const usable = (views as { usable: boolean }[]).filter((v) => v.usable).length;
  console.log(`姿势 ${poses.length}（双人 ${PAIR_TYPES.length} 类），单人视角 ${views.length}（能用 ${usable}），双人视角 ${pairViews.length}`);
}

main();
