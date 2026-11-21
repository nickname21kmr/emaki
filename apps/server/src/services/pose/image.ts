/**
 * 姿势检测的前后处理（原型 dwpose.py、anime_det.py 的移植，DWPose 部分对齐 controlnet_aux 的参考实现）：
 * - 读图：长边缩到 1024 以内，RGB；
 * - 找人（deepghs 动漫人物检测 v1.1_m，YOLOv8m）：640 letterbox（居中、补 114），RGB 0–1；输出 [5, N]，分数 > 0.1 的做 NMS 0.7，
 *   再留超过门槛（threshold.json，0.348）的；一个也没有时整张图当一个框；
 * - DWPose-L：人框放大 1.25 倍、补成 288:384，仿射裁出 288×384，RGB 减均值除方差，SimCC 解码（分辨率 ×2）。
 * 纯函数（除了 loadRgb 读文件），单元测试在 image.test.ts。
 */
import { readFile } from 'node:fs/promises';
import { decodeBmp } from '../image/bmp.ts';
import { htmlAnimationFirstFrame, looksLikeHtmlAnimation } from '../image/htmlAnimation.ts';
import { sharp, SHARP_INPUT } from '../image/sharpConfig.ts';
import { NPTS, type DetectedPerson, type Pt } from '../../domain/pose/features.ts';

export const MAXSIDE = 1024;
/**
 * 缩小用的插值。原型是 cv2 INTER_AREA；200 张原图上和原型 Python 版对比，linear 的点位误差最小（中位 2.6 像素 / 1024），
 * 归类一致 85%（剩下的多在两类交界处），lanczos3 是 4.8 像素、83%
 */
const KERNEL = 'linear';
/** 找人模型的输入边长 */
export const DET = 640;
export const PW = 288;
export const PH = 384;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];
/** 一张图最多给这么多个人跑关键点（超过 4 个像样的人整张不要，多跑也没用） */
export const MAX_PERSONS = 12;

export interface Rgb {
  data: Uint8Array;
  w: number;
  h: number;
}

/** 读文件、解码、长边缩到 1024 以内；透明通道直接丢掉（和 cv2.IMREAD_COLOR 一样） */
export async function loadRgb(path: string): Promise<Rgb> {
  let input: Buffer = await readFile(path);
  if (looksLikeHtmlAnimation(input)) input = htmlAnimationFirstFrame(input);
  let img;
  if (input[0] === 0x42 && input[1] === 0x4d) {
    const raw = decodeBmp(input);
    if (!raw) throw new Error('BMP 解不开');
    img = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
  } else img = sharp(input, { ...SHARP_INPUT, autoOrient: true });
  // 目标尺寸按原型取整（int(w * s)，向下），sharp 自己算会四舍五入、差 1 像素
  const meta = await img.metadata();
  let w0 = meta.width;
  let h0 = meta.pageHeight ?? meta.height;
  if ((meta.orientation ?? 1) >= 5) [w0, h0] = [h0, w0];
  const s = MAXSIDE / Math.max(w0, h0);
  if (s < 1) img = img.resize(Math.max(1, Math.trunc(w0 * s)), Math.max(1, Math.trunc(h0 * s)), { fit: 'fill', kernel: KERNEL });
  const { data, info } = await img
    .timeout({ seconds: 60 })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`通道数异常 ${info.channels}`);
  return { data, w: info.width, h: info.height };
}

/** cv2.resize INTER_LINEAR 的取样位置（半像素对齐，越界夹住） */
function linearTaps(src: number, dst: number) {
  const scale = src / dst;
  const i0 = new Int32Array(dst);
  const f = new Float32Array(dst);
  for (let x = 0; x < dst; x++) {
    let fx = (x + 0.5) * scale - 0.5;
    let sx = Math.floor(fx);
    fx -= sx;
    if (sx < 0) {
      fx = 0;
      sx = 0;
    }
    if (sx >= src - 1) {
      fx = 0;
      sx = src - 1;
    }
    i0[x] = sx;
    f[x] = fx;
  }
  return { i0, f };
}

/** Python 的 round()：正好一半时取偶数（原型按它算缩放后的尺寸） */
const roundHalfEven = (x: number) => {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

export interface Letterbox {
  input: Float32Array;
  /** 原图 → 输入的缩放比例，图在输入里的左上角 */
  ratio: number;
  ox: number;
  oy: number;
}

/**
 * 找人模型的输入：1×3×640×640，RGB、0–1。图按长边缩放到 640（小图也放大），居中放，四周补 114（ultralytics 的 letterbox）。
 * 原型 anime_det.py 的 letterbox 模式（原型里比 imgutils 那种「补成 32 的倍数、不补边」效果好）；缩放是 cv2 INTER_LINEAR，取整到 0–255 再除 255
 */
export function letterbox(img: Rgb): Letterbox {
  const r = DET / Math.max(img.w, img.h);
  const nw = Math.min(DET, Math.max(1, roundHalfEven(img.w * r)));
  const nh = Math.min(DET, Math.max(1, roundHalfEven(img.h * r)));
  const ox = Math.floor((DET - nw) / 2);
  const oy = Math.floor((DET - nh) / 2);
  const plane = DET * DET;
  const input = new Float32Array(3 * plane).fill(114 / 255);
  const xs = linearTaps(img.w, nw);
  const ys = linearTaps(img.h, nh);
  for (let y = 0; y < nh; y++) {
    const y0 = ys.i0[y]!;
    const y1 = Math.min(y0 + 1, img.h - 1);
    const fy = ys.f[y]!;
    for (let x = 0; x < nw; x++) {
      const x0 = xs.i0[x]!;
      const x1 = Math.min(x0 + 1, img.w - 1);
      const fx = xs.f[x]!;
      for (let c = 0; c < 3; c++) {
        const a = img.data[(y0 * img.w + x0) * 3 + c]!;
        const b = img.data[(y0 * img.w + x1) * 3 + c]!;
        const d = img.data[(y1 * img.w + x0) * 3 + c]!;
        const e = img.data[(y1 * img.w + x1) * 3 + c]!;
        const v = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
        input[c * plane + (oy + y) * DET + ox + x] = Math.round(v) / 255;
      }
    }
  }
  return { input, ratio: r, ox, oy };
}

type Box = [number, number, number, number];

function nms(boxes: Box[], scores: number[], thr: number): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  const area = boxes.map(([x1, y1, x2, y2]) => (x2 - x1 + 1) * (y2 - y1 + 1));
  const keep: number[] = [];
  const dead = new Uint8Array(boxes.length);
  for (const i of order) {
    if (dead[i]) continue;
    keep.push(i);
    const [ax1, ay1, ax2, ay2] = boxes[i]!;
    for (const j of order) {
      if (dead[j] || j === i || keep.includes(j)) continue;
      const [bx1, by1, bx2, by2] = boxes[j]!;
      const w = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1) + 1);
      const h = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1) + 1);
      const ovr = (w * h) / (area[i]! + area[j]! - w * h);
      if (ovr > thr) dead[j] = 1;
    }
  }
  return keep;
}

/** 找人：NMS 的 IoU、先留下做 NMS 的最低分（原型 anime_det.py 的 IOU、min(门槛, 0.1)） */
const DET_IOU = 0.7;
const DET_PRE = 0.1;

/**
 * 找人模型的输出（[1, 5, N] 或 [1, N, 5]：cx、cy、w、h，再是每一类的分数，这个模型只有一类）→ 人框（原图坐标）和分数，按分数从高到低。
 * 和原型一样：分数 > 0.1 的先做 NMS（IoU 0.7），再留超过门槛的；框换回原图坐标、夹在图里
 */
export function decodeDetections(
  out: Float32Array,
  dims: readonly number[],
  lb: Pick<Letterbox, 'ratio' | 'ox' | 'oy'>,
  w: number,
  h: number,
  scoreThr: number,
): { boxes: Box[]; scores: number[] } {
  const [a, b] = dims.length === 3 ? [dims[1]!, dims[2]!] : [dims[0]!, dims[1]!];
  // 通道在前（[5, N]）还是在后（[N, 5]）：和原型一样按哪一维小判断
  const chFirst = a <= b;
  const C = chFirst ? a : b;
  const N = chFirst ? b : a;
  const at = (c: number, i: number) => (chFirst ? out[c * N + i]! : out[i * C + c]!);
  const pre = Math.min(scoreThr, DET_PRE);
  const boxes: Box[] = [];
  const scores: number[] = [];
  for (let i = 0; i < N; i++) {
    let s = -Infinity;
    for (let c = 4; c < C; c++) s = Math.max(s, at(c, i));
    if (!(s > pre)) continue;
    const cx = at(0, i);
    const cy = at(1, i);
    const bw = at(2, i);
    const bh = at(3, i);
    boxes.push([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]);
    scores.push(s);
  }
  if (!boxes.length) return { boxes: [], scores: [] };
  const keep = nms(boxes, scores, DET_IOU).filter((k) => scores[k]! > scoreThr);
  const clip = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
  return {
    boxes: keep.map((k) => {
      const [x1, y1, x2, y2] = boxes[k]!;
      const s = 1 / lb.ratio;
      return [clip((x1 - lb.ox) * s, w - 1), clip((y1 - lb.oy) * s, h - 1), clip((x2 - lb.ox) * s, w - 1), clip((y2 - lb.oy) * s, h - 1)] as Box;
    }),
    scores: keep.map((k) => scores[k]!),
  };
}

/** 人框 → 中心和裁剪尺寸（放大 1.25 倍，补成 288:384） */
export function cropFrame(box: readonly number[]): { center: Pt; scale: Pt } {
  const [x1, y1, x2, y2] = box as Box;
  const center: Pt = [(x1 + x2) / 2, (y1 + y2) / 2];
  let sw = (x2 - x1) * 1.25;
  let sh = (y2 - y1) * 1.25;
  const ar = PW / PH;
  if (sw > sh * ar) sh = sw / ar;
  else sw = sh * ar;
  return { center, scale: [sw, sh] };
}

/** 仿射裁剪（cv2.warpAffine INTER_LINEAR，越界是 0）+ 归一化，写进 out 的第 k 张（CHW、RGB） */
export function cropInput(img: Rgb, center: Pt, scale: Pt, out: Float32Array, k: number): void {
  const plane = PW * PH;
  const base = k * 3 * plane;
  const s = scale[0] / PW; // 输出一个像素 = 原图 s 个像素（没有旋转，两个方向一样）
  const px = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= img.w || y >= img.h ? 0 : img.data[(y * img.w + x) * 3 + c]!);
  for (let y = 0; y < PH; y++) {
    const sy = center[1] + (y - PH / 2) * s;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < PW; x++) {
      const sx = center[0] + (x - PW / 2) * s;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const v =
          (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
        out[base + c * plane + y * PW + x] = (v - MEAN[c]!) / STD[c]!;
      }
    }
  }
}

/** SimCC 解码第 k 个人的前 23 个点：每个点 x、y 各自取最大的那一格，置信度取两者小的 */
export function decodeSimcc(
  sx: Float32Array,
  sy: Float32Array,
  dims: { k: number; nx: number; ny: number },
  k: number,
  center: Pt,
  scale: Pt,
): { kp: Pt[]; ks: number[] } {
  const kp: Pt[] = [];
  const ks: number[] = [];
  for (let j = 0; j < NPTS; j++) {
    const ox = (k * dims.k + j) * dims.nx;
    const oy = (k * dims.k + j) * dims.ny;
    let bx = 0;
    let vx = -Infinity;
    for (let i = 0; i < dims.nx; i++) if (sx[ox + i]! > vx) (vx = sx[ox + i]!), (bx = i);
    let by = 0;
    let vy = -Infinity;
    for (let i = 0; i < dims.ny; i++) if (sy[oy + i]! > vy) (vy = sy[oy + i]!), (by = i);
    kp.push([(bx / 2 / PW) * scale[0] + center[0] - scale[0] / 2, (by / 2 / PH) * scale[1] + center[1] - scale[1] / 2]);
    ks.push(Math.min(vx, vy));
  }
  return { kp, ks };
}

/** 没检测到人：整张图当一个框（之后按关键点置信度判断能不能用） */
export function personsOrFallback(img: Rgb, det: { boxes: Box[]; scores: number[] }) {
  if (det.boxes.length) return det.boxes.slice(0, MAX_PERSONS).map((b, i) => ({ box: b, score: det.scores[i]!, fallback: false }));
  return [{ box: [0, 0, img.w - 1, img.h - 1] as Box, score: 0, fallback: true }];
}

export type { DetectedPerson };
