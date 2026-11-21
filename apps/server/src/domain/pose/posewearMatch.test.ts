/**
 * PoseWear 匹配（纯函数）：和原型的一致率（固定小样本：test/fixtures/pose/posewear_match.json，scripts/posewear-agreement.ts 生成）、
 * 配方和强度、阈值（严格 / 低分标签 / 只按标签）、镜像、躺卧转着比、一张图多个姿势、名次分、双人。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { framing, LEG_THR, type Pt } from './features.ts';
import { loadPoseWearAsset, type MaskMode, type PreparedView } from './posewearAsset.ts';
import { matchPair, matchSingle, pairStrength, passes, rankScore, singleStrength, tagScore, twoPeople, type SingleInput } from './posewearMatch.ts';

const asset = loadPoseWearAsset();
const tags = (o: Record<string, number>) => new Map(Object.entries(o));

/** 用线稿视角的骨架当一张图的主要人物（腿上不清楚的点、胸像的髋照 selectPerson 屏蔽） */
function fromView(poseId: string, view: string, extra: Partial<SingleInput> = {}): SingleInput {
  const v = asset.views.find((x) => x.pose === poseId && x.view === view)!;
  return fromPoints(v.points, v.ks, v.h, extra);
}
function fromPoints(kp: readonly Pt[], ks0: readonly number[], h: number, extra: Partial<SingleInput>): SingleInput {
  const ks = ks0.map((s, j) => (j >= 13 && s < LEG_THR ? 0 : s));
  const group = framing(ks, kp, h) as MaskMode;
  return { group, kp, ks, tags: new Map(), low: null, ...extra };
}
const hitOf = (hits: ReturnType<typeof matchSingle>, id: string) => hits.find((h) => h.poseId === id);

describe('和原型一致（固定样本）', () => {
  interface Fx {
    id: number;
    group: MaskMode;
    kp: number[];
    ks: number[];
    tags: Record<string, number>;
    low: Record<string, number> | null;
    expect: { pose: string; method: string; primary: boolean; score: number }[];
  }
  const fx = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../test/fixtures/pose/posewear_match.json'), 'utf8')) as { images: Fx[] };

  it('（图, 姿势）≥ 95% 一致，主要姿势、方法、名次分对得上', () => {
    let proto = 0;
    let mine = 0;
    let both = 0;
    let prim = 0;
    let primN = 0;
    let method = 0;
    let close = 0;
    for (const it of fx.images) {
      const kp = Array.from({ length: 23 }, (_, i) => [it.kp[2 * i]!, it.kp[2 * i + 1]!] as Pt);
      const hits = matchSingle(asset, { group: it.group, kp, ks: it.ks, tags: tags(it.tags), low: it.low ? tags(it.low) : null });
      proto += it.expect.length;
      mine += hits.length;
      for (const e of it.expect) {
        const h = hitOf(hits, e.pose);
        if (!h) continue;
        both++;
        if (h.method === e.method) method++;
        if (Math.abs(h.score - e.score) < 0.01) close++;
      }
      if (it.expect.length && hits.length) {
        primN++;
        if (it.expect.find((e) => e.primary)?.pose === hits.find((h) => h.primary)?.poseId) prim++;
      }
    }
    expect(fx.images.length).toBeGreaterThanOrEqual(150);
    expect(proto).toBeGreaterThan(50);
    expect(both / (proto + mine - both)).toBeGreaterThanOrEqual(0.95);
    expect(prim / primN).toBeGreaterThanOrEqual(0.95);
    expect(method / both).toBeGreaterThanOrEqual(0.98);
    expect(close / both).toBeGreaterThanOrEqual(0.95);
  });
});

describe('配方', () => {
  const p18 = asset.singles.find((p) => p.id === 'full_single_P018')!;
  const generic = new Set(asset.params.single.generic);

  it('每个子句有一个就算，none_of 有一个就不算；标签分是各子句最高分的平均；强度只数非通用标签满足的子句', () => {
    const a = { all_of_any: [['standing'], ['hands_on_own_hips', 'hand_on_own_hip']], none_of: ['sitting'] };
    expect(passes(tags({ standing: 0.9, hand_on_own_hip: 0.5 }), a)).toBe(true);
    expect(passes(tags({ standing: 0.9 }), a)).toBe(false);
    expect(passes(tags({ standing: 0.9, hand_on_own_hip: 0.5, sitting: 0.4 }), a)).toBe(false);
    // 低分标签的 none_of 不否决：否决只看严格的
    expect(passes(tags({ standing: 0.9, hand_on_own_hip: 0.5, sitting: 0.2 }), a, tags({ standing: 0.9 }))).toBe(true);
    expect(tagScore(tags({ standing: 0.9, hands_on_own_hips: 0.4, hand_on_own_hip: 0.6 }), a)).toBeCloseTo(0.75);
    expect(singleStrength(p18, a, tags({ standing: 0.9, hand_on_own_hip: 0.5 }), generic)).toBe(1);
    // 只有身体姿态的配方强度是 0
    expect(singleStrength({ ...p18, level: 'posture' }, a, tags({ standing: 0.9, hand_on_own_hip: 0.5 }), generic)).toBe(0);
  });

  it('双人：决定性的标签一个算 2，非通用的算 1，最多 2；数人头：两个人、couple，群交一类的不算', () => {
    const generic = new Set(asset.params.pair.generic);
    const defining = new Set(asset.params.pair.defining);
    expect(pairStrength({ all_of_any: [['princess_carry']], none_of: [] }, tags({ princess_carry: 0.8 }), generic, defining)).toBe(2);
    expect(pairStrength({ all_of_any: [['carrying'], ['hug']], none_of: [] }, tags({ carrying: 0.8, hug: 0.5 }), generic, defining)).toBe(2);
    expect(pairStrength({ all_of_any: [['carrying'], ['standing']], none_of: [] }, tags({ carrying: 0.8, standing: 0.5 }), generic, defining)).toBe(1);
    expect(twoPeople(asset, tags({ '2girls': 0.9 }))).toBe(true);
    expect(twoPeople(asset, tags({ '1girl': 0.9, '1boy': 0.8 }))).toBe(true);
    expect(twoPeople(asset, tags({ couple: 0.6 }))).toBe(true);
    expect(twoPeople(asset, tags({ '1girl': 0.9 }))).toBe(false);
    expect(twoPeople(asset, tags({ '2girls': 0.9, threesome: 0.5 }))).toBe(false);
  });
});

describe('单人匹配', () => {
  const strict = tags({ standing: 0.9, hands_on_own_hips: 0.8 });

  it('骨架像、标签过了：tags+skel，距离近，是主要的；没有标签不算；名次分 = 0.6·(1 − 距离/阈值) + 0.4·标签分', () => {
    const hits = matchSingle(asset, fromView('full_single_P018', 'front', { tags: strict }));
    const h = hitOf(hits, 'full_single_P018')!;
    expect(h).toMatchObject({ method: 'tags+skel', view: 'front', rotation: 0 });
    expect(h.distNorm!).toBeLessThan(0.05);
    expect(h.tagScore).toBeCloseTo(0.85);
    expect(h.score).toBeCloseTo(0.6 * (1 - h.distNorm!) + 0.4 * 0.85, 6);
    expect(hits.filter((x) => x.primary)).toHaveLength(1);
    expect(hitOf(matchSingle(asset, fromView('full_single_P018', 'front')), 'full_single_P018')).toBeUndefined();
    expect(rankScore(asset, 'tag_only', null, 0.7)).toBeCloseTo(0.28);
  });

  it('镜像（左右翻过来）一样匹配上', () => {
    const v = asset.views.find((x) => x.pose === 'full_single_P018' && x.view === 'front')!;
    const flipped = v.points.map(([x, y]) => [v.w - x, y] as Pt);
    const h = hitOf(matchSingle(asset, fromPoints(flipped, v.ks, v.h, { tags: strict })), 'full_single_P018')!;
    expect(h.method).toBe('tags+skel');
    expect(h.distNorm!).toBeLessThan(0.05);
  });

  it('骨架不像（换成别的姿势的骨架）：过不了阈值', () => {
    const hits = matchSingle(asset, fromView('full_single_P019', 'front', { tags: strict }));
    const h = hitOf(hits, 'full_single_P018');
    expect(h === undefined || h.distNorm! <= 1).toBe(true);
    // 阈值是按强度 1 的全身阈值：P018 是「细节」姿势（名字里有手），不放宽
    const p = asset.singles.find((x) => x.id === 'full_single_P018')!;
    expect(p.posture).toBe(false);
    if (h) expect(h.distance! / h.distNorm!).toBeCloseTo(asset.params.single.thrFull[1]!, 6);
  });

  it('低分标签：只靠低分过配方的，骨架阈值再乘 F_LOW（0.45），方法 lowtag+skel，排主要姿势时往后放，名次分不罚', () => {
    const low = tags({ standing: 0.9, hands_on_own_hips: 0.2 });
    const hits = matchSingle(asset, fromView('full_single_P018', 'front', { tags: tags({ standing: 0.9 }), low }));
    const h = hitOf(hits, 'full_single_P018')!;
    expect(h.method).toBe('lowtag+skel');
    expect(h.distance! / h.distNorm!).toBeCloseTo(asset.params.single.thrFull[1]! * asset.params.single.lowFactor, 6);
    expect(h.key).toBeCloseTo(h.distNorm! + asset.params.single.lowKeyPenalty, 6);
    expect(h.tagScore).toBeCloseTo((0.9 + 0.2) / 2);
    expect(h.score).toBeCloseTo(0.6 * (1 - h.distNorm!) + 0.4 * h.tagScore, 6);
    // 没有低分标签（库里还没补）：不算
    expect(hitOf(matchSingle(asset, fromView('full_single_P018', 'front', { tags: tags({ standing: 0.9 }) })), 'full_single_P018')).toBeUndefined();
    // 低于 0.17 的不算
    expect(hitOf(matchSingle(asset, fromView('full_single_P018', 'front', { tags: tags({ standing: 0.9 }), low: tags({ hands_on_own_hips: 0.1 }) })), 'full_single_P018')).toBeUndefined();
  });

  it('躺卧一类：图的骨架转 90° 也能比上', () => {
    const v = asset.views.find((x) => x.pose === 'full_single_P007' && x.view === 'front')!;
    const t = tags({ lying: 0.9, arm_support: 0.8 });
    const up = hitOf(matchSingle(asset, fromView('full_single_P007', 'front', { tags: t })), 'full_single_P007')!;
    expect(up).toMatchObject({ method: 'tags+skel', rotation: 0 });
    // 转 90°（坐标 (x, y) → (y, −x)）：比的时候再转回来
    const turned = v.points.map(([x, y]) => [y, 1 - x] as Pt);
    const input = { ...fromView('full_single_P007', 'front', { tags: t }), kp: turned };
    const h = hitOf(matchSingle(asset, input), 'full_single_P007')!;
    expect(h.method).toBe('tags+skel');
    expect(h.rotation).not.toBe(0);
    expect(h.distNorm!).toBeLessThan(0.1);
  });

  it('没有能用视角的姿势：强度 ≥ 1、标签分 ≥ 0.45 按标签匹配（tag_only，没有距离），名次分的骨架项是 0', () => {
    const p = asset.singles.find((x) => x.id === 'upper80v2_P002')!;
    expect(p.hasView).toBe(false);
    const any = asset.views.find((x) => asset.singles[x.poseIndex]!.upper) as PreparedView;
    const hits = matchSingle(asset, fromPoints(any.points, any.ks, any.h, { tags: tags({ heart_arms: 0.6 }) }));
    const h = hitOf(hits, 'upper80v2_P002')!;
    expect(h).toMatchObject({ method: 'tag_only', distance: null, distNorm: null, view: null });
    expect(h.score).toBeCloseTo(0.4 * 0.6);
    expect(hitOf(matchSingle(asset, fromPoints(any.points, any.ks, any.h, { tags: tags({ heart_arms: 0.4 }) })), 'upper80v2_P002')).toBeUndefined();
  });

  it('一张图可以匹配好几个姿势，主要的只有一个（key 最小）', () => {
    const fx = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../test/fixtures/pose/posewear_match.json'), 'utf8')) as {
      images: { group: MaskMode; kp: number[]; ks: number[]; tags: Record<string, number>; low: Record<string, number> | null; expect: unknown[] }[];
    };
    const it = fx.images.find((x) => x.expect.length >= 2)!;
    const kp = Array.from({ length: 23 }, (_, i) => [it.kp[2 * i]!, it.kp[2 * i + 1]!] as Pt);
    const hits = matchSingle(asset, { group: it.group, kp, ks: it.ks, tags: tags(it.tags), low: it.low ? tags(it.low) : null });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.filter((h) => h.primary)).toEqual([hits[0]]);
    expect([...hits].sort((a, b) => a.key - b.key)).toEqual(hits);
  });
});

describe('双人匹配', () => {
  const view = asset.pairViews.find((v) => v.pose === 'P054' && v.persons.length >= 2)!;
  const pair = { a: view.points[0]!, b: view.points[1]! };

  it('两个人的骨架像、标签过了：tags+skel；没有骨架时决定性标签 + 标签分够按标签匹配；不是两个人不匹配', () => {
    const t = tags({ '2girls': 0.9, princess_carry: 0.8 });
    const withSkel = matchPair(asset, { tags: t, pair });
    expect(withSkel.find((h) => h.poseId === 'pair_P054')).toMatchObject({ method: 'tags+skel', primary: true, view: view.view });
    expect(withSkel.find((h) => h.poseId === 'pair_P054')!.distNorm!).toBeLessThan(0.1);
    const tagOnly = matchPair(asset, { tags: t, pair: null });
    expect(tagOnly.find((h) => h.poseId === 'pair_P054')).toMatchObject({ method: 'tag_only', distance: null });
    expect(tagOnly.find((h) => h.poseId === 'pair_P054')!.score).toBeCloseTo(0.4 * 0.8);
    // 强度 1（只是 carrying + hug 外的通用标签）没有骨架时不按标签收
    expect(matchPair(asset, { tags: tags({ '2girls': 0.9, carrying: 0.8, arched_back: 0.6 }), pair: null })).toEqual([]);
    expect(matchPair(asset, { tags: tags({ '3girls': 0.9, princess_carry: 0.8 }), pair: null })).toEqual([]);
  });

  it('一类里几个 pair60 姿势取最像的；成人一类照样匹配（显示时再看模糊）', () => {
    const hits = matchPair(asset, { tags: tags({ '1girl': 0.9, '1boy': 0.9, sitting_on_lap: 0.7, hug: 0.6, hug_from_behind: 0.7, sitting: 0.8, cowgirl_position: 0.6 }), pair: null });
    expect(hits.map((h) => h.poseId).sort()).toEqual(['pair_P009', 'pair_P023']);
    expect(hits.filter((h) => h.primary)).toHaveLength(1);
  });
});
