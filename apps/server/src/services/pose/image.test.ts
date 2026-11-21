/**
 * 姿势检测的前后处理（不跑模型）：找人模型的 letterbox、输出解码和 NMS（夹具是原型 Python 版对一张真图的模型输出和解码结果）、
 * 裁剪框、SimCC 解码回原图坐标。DWPose 部分和原型 Python 版的端到端对比（真模型、200 张原图）：点位误差中位 2.6 像素（长边 1024）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNpz } from '../../infra/npz.ts';
import { cropFrame, cropInput, decodeDetections, decodeSimcc, DET, letterbox, PH, personsOrFallback, PW } from './image.ts';

describe('姿势检测的前后处理', () => {
  it('letterbox：按长边缩到 640、居中，其余补 114，RGB、除 255', () => {
    const img = { w: 2, h: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0]) }; // 两个红点
    const { input, ratio, ox, oy } = letterbox(img);
    expect([ratio, ox, oy]).toEqual([320, 0, 160]);
    const plane = DET * DET;
    const at = (c: number, y: number, x: number) => input[c * plane + y * DET + x];
    expect([at(0, 160, 0), at(1, 160, 0), at(2, 160, 0)]).toEqual([1, 0, 0]); // R G B
    expect(at(0, 0, 0)).toBeCloseTo(114 / 255); // 上面是补的
    expect(at(0, 480, 0)).toBeCloseTo(114 / 255); // 下面也是
    // 竖图：左右补边，奇数的余量放右边（和原型的 // 2 一样）
    const tall = letterbox({ w: 3, h: 4, data: new Uint8Array(36).fill(9) });
    expect([tall.ratio, tall.ox, tall.oy]).toEqual([160, 80, 0]);
  });

  it('找人：原型对两个女孩重叠的那张图的模型输出，解码出同样的两个框（NMS 去掉重复的）', () => {
    const z = readNpz(readFileSync(path.resolve(import.meta.dirname, '../../../test/fixtures/pose/anime_det_two.npz')));
    const out = z.get('out')!;
    const [ratio, ox, oy] = Array.from(z.get('lb')!.data as Float64Array);
    const [w, h] = Array.from(z.get('wh')!.data as Int32Array);
    const want = z.get('boxes')!.data as Float32Array;
    const wantScores = Array.from(z.get('scores')!.data as Float32Array);
    // 分数超过 0.1 的候选不止两个：重复的靠 NMS 去掉
    const n = out.shape[2]!;
    const cands = Array.from({ length: n }, (_, i) => (out.data as Float32Array)[4 * n + i]!).filter((v) => v > 0.1);
    expect(cands.length).toBeGreaterThan(2);
    const { boxes, scores } = decodeDetections(out.data as Float32Array, out.shape, { ratio: ratio!, ox: ox!, oy: oy! }, w!, h!, 0.348);
    expect(scores).toHaveLength(2);
    scores.forEach((v, k) => expect(v).toBeCloseTo(wantScores[k]!, 5));
    boxes.flat().forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 2));
  });

  it('找人：[N, 5] 的输出也认；低于门槛的不要，框夹在图里', () => {
    // 两个候选：一个超出图的右下角，一个分数 0.3 < 0.348
    const rows = [
      [600, 600, 100, 100, 0.9],
      [100, 100, 50, 50, 0.3],
      ...Array.from({ length: 6 }, () => [0, 0, 0, 0, 0]), // 候选比通道多（真模型是 8400 个），方向才认得出
    ];
    const flatNC = Float32Array.from(rows.flat());
    const lb = { ratio: 0.5, ox: 0, oy: 0 }; // 原图 1280×1280
    const a = decodeDetections(flatNC, [1, 8, 5], lb, 1280, 1280, 0.348);
    expect(a.scores).toEqual([expect.closeTo(0.9, 5)]);
    expect(a.boxes[0]).toEqual([1100, 1100, 1279, 1279]);
    // 通道在前（[1, 5, N]）是同一个结果
    const flatCN = Float32Array.from([0, 1, 2, 3, 4].flatMap((c) => rows.map((r) => r[c]!)));
    expect(decodeDetections(flatCN, [1, 5, 8], lb, 1280, 1280, 0.348)).toEqual(a);
    // 一个也没有
    expect(decodeDetections(new Float32Array(40), [1, 5, 8], lb, 10, 10, 0.348)).toEqual({ boxes: [], scores: [] });
  });

  it('没检测到人：整张图当一个框', () => {
    expect(personsOrFallback({ w: 10, h: 20, data: new Uint8Array(600) }, { boxes: [], scores: [] })).toEqual([{ box: [0, 0, 9, 19], score: 0, fallback: true }]);
  });

  it('裁剪框补成 288:384；SimCC 中间那一格回到框的中心', () => {
    const f = cropFrame([100, 100, 300, 200]);
    expect(f.center).toEqual([200, 150]);
    expect(f.scale[0] / f.scale[1]).toBeCloseTo(PW / PH);
    const nx = PW * 2;
    const ny = PH * 2;
    const sx = new Float32Array(133 * nx);
    const sy = new Float32Array(133 * ny);
    for (let j = 0; j < 133; j++) {
      sx[j * nx + PW] = 1; // 第 PW 格 = x 方向的中点
      sy[j * ny + PH] = 0.7;
    }
    const { kp, ks } = decodeSimcc(sx, sy, { k: 133, nx, ny }, 0, f.center, f.scale);
    expect(kp).toHaveLength(23);
    expect(kp[0]![0]).toBeCloseTo(200);
    expect(kp[0]![1]).toBeCloseTo(150);
    expect(ks[0]).toBeCloseTo(0.7);
  });

  it('仿射裁剪：框中心的像素落在裁剪图中心，框外是 0（归一化后是 -均值/方差）', () => {
    const w = 40;
    const h = 40;
    const data = new Uint8Array(w * h * 3).fill(200);
    const f = cropFrame([0, 0, 39, 39]); // 放大 1.25 倍后左上角在图外
    const out = new Float32Array(3 * PW * PH);
    cropInput({ w, h, data }, f.center, f.scale, out, 0);
    expect(out[(PH / 2) * PW + PW / 2]).toBeCloseTo((200 - 123.675) / 58.395);
    expect(out[0]).toBeCloseTo(-123.675 / 58.395);
  });
});
