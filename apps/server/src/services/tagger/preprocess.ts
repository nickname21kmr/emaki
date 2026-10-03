/**
 * 模型输入预处理，对齐官方 Space 的 app.py：RGBA 合成到白底 → 居中补白成正方形 → BICUBIC 缩到 448 → float32 0–255 → BGR。
 * sharp 的 extend() 永远在 resize 之后执行，所以用 fit:'contain' + 白色背景代替「先补白再缩放」（±1 像素的取整差异）。
 */
import { readFile } from 'node:fs/promises';
import { decodeBmp } from '../image/bmp.ts';
import { sharp } from '../image/sharpConfig.ts';
import type { TaggerModelSpec } from './models.ts';

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
/** 一张图解码缩放最多给这么久（libvips 自己中止）；几亿像素的大图也就几秒，卡住多半是文件有问题 */
const SHARP_TIMEOUT = { seconds: 60 };

/** BMP（sharp 不支持）先用自己的解码器转成 raw，再走同样的流程 */
function open(input: string | Buffer) {
  if (Buffer.isBuffer(input) && input[0] === 0x42 && input[1] === 0x4d) {
    const raw = decodeBmp(input);
    if (raw) return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }).timeout(SHARP_TIMEOUT);
  }
  return sharp(input, { failOn: 'none', autoOrient: true }).timeout(SHARP_TIMEOUT); // 默认只读第一帧（GIF / 动图 WebP）
}

export type PreprocessResult =
  | { ok: true; data: Float32Array }
  | { ok: false; code: 'ENOENT' | 'IO' | 'UNSUPPORTED' | 'DECODE'; message: string };

/** 文件不在了 */
const GONE = new Set(['ENOENT', 'ENOTDIR']);
/** 不会自己好的读取错误（没权限、其实是文件夹、路径太长、文件太大）：按图片问题记；其余（被占用、掉线、网络盘出错……）都下次再试 */
const PERMANENT = new Set(['EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', 'ERR_FS_FILE_TOO_LARGE']);
/**
 * 读文件 + 预处理，错误按原因分类（预处理线程和主线程共用）：
 * - ENOENT：文件不在了，交给扫描器标丢失
 * - IO：文件暂时读不了（被别的程序占着、移动硬盘掉线），这次不记，下次识别再试
 * - UNSUPPORTED / DECODE：图片本身的问题，记成识别过，不再反复卡在它上面
 */
export async function preprocessFile(spec: TaggerModelSpec, path: string): Promise<PreprocessResult> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (GONE.has(code)) return { ok: false, code: 'ENOENT', message: '文件不存在' };
    if (PERMANENT.has(code)) return { ok: false, code: 'DECODE', message: `读取失败（${code}）` };
    return { ok: false, code: 'IO', message: `读取失败（${code || (err as Error).message}），下次再试` };
  }
  try {
    return { ok: true, data: await preprocess(spec, buf) };
  } catch (err) {
    const msg = (err as Error).message;
    // 解码超时多半是机器当时太忙（几亿像素的图也就几秒），下次再试
    if (/timeout/i.test(msg)) return { ok: false, code: 'IO', message: `解码超时，下次再试（${msg}）` };
    return { ok: false, code: /unsupported image format/i.test(msg) ? 'UNSUPPORTED' : 'DECODE', message: msg };
  }
}

/** WD v3：返回长度 size*size*3 的 Float32Array，HWC、BGR、0~255 */
export async function preprocessWdV3(input: string | Buffer, size = 448): Promise<Float32Array> {
  const { data, info } = await open(input)
    .flatten({ background: WHITE }) // 透明 → 白底
    .resize(size, size, { fit: 'contain', background: WHITE, kernel: 'cubic', position: 'centre' })
    .toColourspace('srgb') // 灰度 / CMYK / 16 位 PNG 都统一成 8 位 sRGB 3 通道
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 3) {
    throw new Error(`预处理尺寸异常 ${info.width}x${info.height}x${info.channels}`);
  }
  const out = new Float32Array(size * size * 3);
  for (let i = 0, n = size * size; i < n; i++) {
    const o = i * 3;
    out[o] = data[o + 2]!; // B
    out[o + 1] = data[o + 1]!; // G
    out[o + 2] = data[o]!; // R
  }
  return out;
}

/** PixAI v0.9：CHW、RGB、(x/255-0.5)/0.5，直接拉伸到 448×448，不补白 */
export async function preprocessPixai(input: string | Buffer, size = 448): Promise<Float32Array> {
  const { data } = await open(input)
    .flatten({ background: WHITE })
    .resize(size, size, { fit: 'fill', kernel: 'linear' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plane = size * size;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 3 + c]! / 255 - 0.5) / 0.5;
  }
  return out;
}

const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };

/**
 * PixAI v1.0：对齐 noaione/pixai-tagger-v1.0-onnx 的 run_onnx.py —— 透明合成到白底 → 等比缩放（BILINEAR）→ 居中补黑边到 1008
 * → CHW、RGB、(x/255-0.5)/0.5（补的黑边正好是 -1）
 */
export async function preprocessPixaiV1(input: string | Buffer, size = 1008): Promise<Float32Array> {
  const { data, info } = await open(input)
    .flatten({ background: WHITE })
    .resize(size, size, { fit: 'contain', background: BLACK, kernel: 'linear', position: 'centre' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 3) {
    throw new Error(`预处理尺寸异常 ${info.width}x${info.height}x${info.channels}`);
  }
  const plane = size * size;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = data[i * 3 + c]! / 127.5 - 1;
  }
  return out;
}

export function preprocess(spec: TaggerModelSpec, input: string | Buffer): Promise<Float32Array> {
  if (spec.preprocess === 'wd-v3') return preprocessWdV3(input, spec.inputSize);
  if (spec.preprocess === 'pixai-v1') return preprocessPixaiV1(input, spec.inputSize);
  return preprocessPixai(input, spec.inputSize);
}

export const perImage = (spec: TaggerModelSpec) => spec.inputSize * spec.inputSize * 3;
