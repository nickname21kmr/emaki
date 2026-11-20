/**
 * 移植一致率：原型（cluster_full.py）在 400 张图上的归类（300 张归了类、100 张没归类，固定抽样），
 * 用同样的检测结果跑 TypeScript 版，类别（含「不归类」）要和原型一致 >= 95%。
 * 夹具由 F:/Claude/.work/pose-ext/scripts/build_assets.py 从原型的 keypoints_lib.npz / assignments.json 生成。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classRefs, loadPoseAsset } from './asset.ts';
import { assignImage, packPerson, unpackPerson, type DetectedPerson } from './features.ts';

interface Item {
  id: number;
  w: number;
  h: number;
  persons: DetectedPerson[];
  expect: { class: string; group: string | null; distance: number | null; mirror: boolean | null; reason: string | null; nearest: string | null };
}

const items = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../test/fixtures/pose/agreement.json'), 'utf8')) as Item[];
const refs = classRefs(loadPoseAsset());

describe('姿势归类和原型一致', () => {
  it('400 张图里类别一致 >= 95%', () => {
    let same = 0;
    let classified = 0;
    let classifiedSame = 0;
    const diffs: string[] = [];
    const distDiffs: string[] = [];
    for (const it of items) {
      const a = assignImage(it.persons, it.w, it.h, refs);
      const got = a.classId ?? 'unclassified';
      if (got === it.expect.class) same++;
      else diffs.push(`${it.id}: ${it.expect.class}(${it.expect.reason ?? ''}) → ${got}(${a.status})`);
      if (it.expect.class !== 'unclassified') {
        classified++;
        if (got === it.expect.class) {
          classifiedSame++;
          // 同一类时距离也对得上（float32 和 float64 的差别）
          if (Math.abs(a.distance! - it.expect.distance!) > 0.005) distDiffs.push(`${it.id} ${it.expect.class} ${it.expect.distance} → ${a.distance!.toFixed(4)}`);
        }
      }
    }
    const rate = same / items.length;
    console.log(`[pose] 一致 ${same}/${items.length} = ${(rate * 100).toFixed(1)}%（归了类的 ${classifiedSame}/${classified}）`);
    if (diffs.length) console.log(diffs.slice(0, 20).join('\n'));
    if (distDiffs.length) console.log('距离对不上：', distDiffs.join('；'));
    expect(distDiffs.length).toBeLessThanOrEqual(items.length * 0.02);
    expect(items.length).toBeGreaterThanOrEqual(200);
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });

  it('存储格式往返：按长边归一后归类不变', () => {
    for (const it of items.slice(0, 50)) {
      const a = assignImage(it.persons, it.w, it.h, refs);
      if (!a.person) continue;
      const back = unpackPerson(packPerson(a.person, it.w, it.h));
      const p: DetectedPerson = { box: [0, 0, 1, 1], score: 1, fallback: false, kp: back.person.kp, ks: back.person.ks };
      // 存的是屏蔽之后的点，重新归类不再筛选：直接比距离
      const b = assignImage([p], back.w, back.h, refs);
      if (b.classId !== null && a.classId !== null) expect(b.classId).toBe(a.classId);
    }
  });
});
