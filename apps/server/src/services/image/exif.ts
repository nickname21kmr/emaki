/**
 * 从 EXIF 认出「相机拍的照片」（T27，CL-photo）：只看 Make / Model 和拍摄参数，不解码像素。
 *
 * 判为相机：有 Make 和 Model，并且 Exif 子 IFD 里有曝光时间、光圈、拍摄时间之一，且 Model 不像扫描仪。
 * 只有 Software 字段（Photoshop、美图）的不算。
 */
import { open } from 'node:fs/promises';

const MAKE = 0x010f;
const MODEL = 0x0110;
const EXIF_IFD = 0x8769;
const SHOOTING = new Set([0x829a /* ExposureTime */, 0x829d /* FNumber */, 0x9003 /* DateTimeOriginal */]);
const HEAD_BYTES = 128 * 1024;

/**
 * exif：sharp metadata().exif 或 readJpegExifHead 的结果（带不带 'Exif\0\0' 前缀都行）。
 * 返回 'Make Model'；不是相机返回 ''。
 */
export function readCameraFromExif(exif: Buffer | undefined): string {
  if (!exif || exif.length < 8) return '';
  const buf = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif;
  const order = buf.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return '';
  const le = order === 'II';
  const r16 = (p: number) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const r32 = (p: number) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));

  let make = '';
  let model = '';
  let shooting = false;
  const walk = (p: number, depth: number) => {
    if (p <= 0 || p + 2 > buf.length) return;
    const n = r16(p);
    for (let k = 0; k < n; k++) {
      const e = p + 2 + k * 12;
      if (e + 12 > buf.length) return;
      const tag = r16(e);
      if (depth === 1 && SHOOTING.has(tag)) shooting = true;
      if (depth === 0 && tag === EXIF_IFD) {
        walk(r32(e + 8), 1);
        continue;
      }
      if (depth !== 0 || (tag !== MAKE && tag !== MODEL) || r16(e + 2) !== 2 /* ASCII */) continue;
      const cnt = r32(e + 4);
      const at = cnt <= 4 ? e + 8 : r32(e + 8);
      if (at + cnt > buf.length) continue;
      const s = buf
        .subarray(at, at + cnt)
        .toString('latin1')
        .replace(/\0+$/, '')
        .trim();
      if (tag === MAKE) make = s;
      else model = s;
    }
  };
  try {
    walk(r32(4), 0);
  } catch {
    return '';
  }
  if (!make || !model || !shooting || /scan/i.test(model)) return '';
  // 「HUAWEI」+「HUAWEI EML-AL00」这类型号里已经带了品牌的，不重复
  return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
}

/** 只读文件前 128KB，按段扫描到 APP1「Exif」为止；碰到图像数据（SOS）就停。不是 JPEG 或没有 EXIF 返回 undefined */
export async function readJpegExifHead(absPath: string): Promise<Buffer | undefined> {
  const fh = await open(absPath, 'r');
  let b: Buffer;
  try {
    b = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(b, 0, HEAD_BYTES, 0);
    b = b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return undefined;
    const marker = b[p + 1]!;
    const len = b.readUInt16BE(p + 2);
    if (marker === 0xe1 && b.subarray(p + 4, p + 10).toString('latin1') === 'Exif\0\0') return b.subarray(p + 10, p + 2 + len);
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return undefined;
}
