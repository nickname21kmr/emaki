/**
 * 读 numpy 的 .npz（zip 里一组 .npy）：只支持一维、多维的小端数值数组和布尔，够读姿势原型的关键点文件。
 * 不加依赖：zip 的中央目录自己解析（含 zip64 扩展），压缩的用 zlib.inflateRawSync。
 */
import { inflateRawSync } from 'node:zlib';

export interface NpyArray {
  dtype: string;
  shape: number[];
  data: Float64Array | Float32Array | Int32Array | Int16Array | Int8Array | Uint8Array | BigInt64Array;
}

function zip64Extra(extra: Buffer, want: { size: boolean; csize: boolean; offset: boolean }) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 1) {
      let q = p + 4;
      const out: { size?: number; csize?: number; offset?: number } = {};
      if (want.size) (out.size = Number(extra.readBigUInt64LE(q))), (q += 8);
      if (want.csize) (out.csize = Number(extra.readBigUInt64LE(q))), (q += 8);
      if (want.offset) out.offset = Number(extra.readBigUInt64LE(q));
      return out;
    }
    p += 4 + len;
  }
  return {};
}

/** zip 里的文件：名字 → 解压后的内容 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // 中央目录结束记录（可能带注释）：从末尾往前找签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到中央目录）');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // zip64：结束记录前面是 zip64 定位记录
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z + 32));
      cdOffset = Number(buf.readBigUInt64LE(z + 48));
    }
  }
  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const z = zip64Extra(extra, { size: size === 0xffffffff, csize: csize === 0xffffffff, offset: local === 0xffffffff });
    size = z.size ?? size;
    csize = z.csize ?? csize;
    local = z.offset ?? local;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    if (data.length !== size) throw new Error(`${name} 解压后大小不符`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** 一个 .npy；float16 转成 Float32Array */
export function parseNpy(buf: Buffer): NpyArray {
  if (buf.readUInt8(0) !== 0x93 || buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('不是 .npy');
  const major = buf.readUInt8(6);
  const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const header = buf.toString('latin1', hstart, hstart + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*True/.test(header);
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  if (!descr || fortran) throw new Error(`不支持的 .npy 头：${header}`);
  const shape = shapeStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const n = shape.reduce((a, b) => a * b, 1);
  const body = buf.subarray(hstart + hlen);
  // 拷一份：保证对齐
  const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const dtype = descr.replace(/^[<|=]/, '');
  if (descr.startsWith('>')) throw new Error('不支持大端');
  let data: NpyArray['data'];
  switch (dtype) {
    case 'f8': data = new Float64Array(ab, 0, n); break;
    case 'f4': data = new Float32Array(ab, 0, n); break;
    case 'f2': {
      const u = new Uint16Array(ab, 0, n);
      data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = half(u[i]!);
      break;
    }
    case 'i8': data = new BigInt64Array(ab, 0, n); break;
    case 'i4': data = new Int32Array(ab, 0, n); break;
    case 'i2': data = new Int16Array(ab, 0, n); break;
    case 'i1': data = new Int8Array(ab, 0, n); break;
    case 'b1':
    case 'u1': data = new Uint8Array(ab, 0, n); break;
    default: throw new Error(`不支持的类型 ${descr}`);
  }
  return { dtype, shape, data };
}

export function readNpz(buf: Buffer): Map<string, NpyArray> {
  const out = new Map<string, NpyArray>();
  for (const [name, data] of readZipEntries(buf)) if (name.endsWith('.npy')) out.set(name.slice(0, -4), parseNpy(data));
  return out;
}
