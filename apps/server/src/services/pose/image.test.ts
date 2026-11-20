/**
 * 姿势检测的前后处理（不跑模型）：letterbox 的补边和颜色顺序、YOLOX 网格解码和 NMS、裁剪框、SimCC 解码回原图坐标。
 * 和原型 Python 版的端到端对比（真模型、200 张原图）见交付说明：点位误差中位 2.6 像素（长边 1024）。
 */
import { describe, expect, it } from 'vitest';
import { cropFrame, cropInput, decodeSimcc, decodeYolox, DET, letterbox, PH, personsOrFallback, PW } from './image.ts';

describe('姿势检测的前后处理', () => {
  it('letterbox：左上对齐、其余补 114、RGB 转成 BGR', () => {
    const img = { w: 2, h: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 0]) }; // 两个红点
    const { input, ratio } = letterbox(img);
    expect(ratio).toBe(320);
    const plane = DET * DET;
    expect([input[0], input[plane], input[2 * plane]]).toEqual([0, 0, 255]); // B G R
    expect(input[DET * (DET - 1)]).toBe(114); // 最后一行是补的
  });

  it('YOLOX：网格解码回原图坐标，重叠的框只留分数高的', () => {
    const out = new Float32Array(8400 * 85);
    const put = (i: number, dx: number, dy: number, w: number, h: number, obj: number, cls: number) => out.set([dx, dy, Math.log(w), Math.log(h), obj, cls], i * 85);
    // 步长 8 的第 (y=10, x=20) 格：中心 (160, 80)，宽高 8×(16, 32)
    put(10 * 80 + 20, 0, 0, 16, 32, 0.9, 0.9);
    put(10 * 80 + 21, 0, 0, 16, 32, 0.8, 0.8); // 几乎重合，被 NMS 去掉
    put(0, 0, 0, 1, 1, 0.5, 0.5); // 0.25 < 0.3
    const { boxes, scores } = decodeYolox(out, 0.5);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toBeCloseTo(0.81);
    expect(boxes[0]!.map((v) => Math.round(v))).toEqual([(160 - 64) * 2, (80 - 128) * 2, (160 + 64) * 2, (80 + 128) * 2]);
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
