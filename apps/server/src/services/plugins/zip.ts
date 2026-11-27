/**
 * 解开插件的 zip 包（docs/plugins.md E2）。只认插件包用得到的：不加密、不分卷、不是 zip64，压缩方式是「不压缩」或 deflate。
 * 不依赖第三方库：读中央目录，逐个按本地文件头取数据，用 zlib 解压，校验长度和 CRC。
 *
 * 安全：路径一律当成相对路径，带 `..`、绝对路径、盘符的整包拒绝；符号链接拒绝；文件数、单个文件、总大小都有上限
 * （防 zip 炸弹：解压时 maxOutputLength 卡住，不先信头里写的大小）。
 */
import * as zlib from 'node:zlib';

export class ZipError extends Error {}

export interface ZipLimits {
  maxFiles: number;
  /** 单个文件解开后最大 */
  maxEntry: number;
  /** 全部解开后最大 */
  maxTotal: number;
}

export const PLUGIN_ZIP_LIMITS: ZipLimits = { maxFiles: 2000, maxEntry: 20 * 1024 * 1024, maxTotal: 60 * 1024 * 1024 };

export interface ZipEntry {
  /** 用 / 分隔的相对路径 */
  path: string;
  data: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** 包里的路径 → 安全的相对路径；不安全的返回 null */
export function safeEntryPath(name: string): string | null {
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/').filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.includes('\0'))) return null;
  return parts.join('/');
}

export function unzip(buf: Buffer, limits: ZipLimits = PLUGIN_ZIP_LIMITS): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('不是 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('这个 zip 太大了（zip64），插件包用不着这么大');
  if (count > limits.maxFiles) throw new ZipError(`文件太多（${count} 个，最多 ${limits.maxFiles} 个）`);
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('zip 文件坏了（目录读不出来）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.endsWith('\\')) continue; // 文件夹
    if (flags & 1) throw new ZipError('zip 加了密码，解不开');
    if (((external >>> 16) & S_IFMT) === S_IFLNK) throw new ZipError(`包里有符号链接（${name}），不接受`);
    const path = safeEntryPath(name);
    if (!path) throw new ZipError(`包里的路径不安全：${name}`);
    if (usize > limits.maxEntry) throw new ZipError(`${path} 太大了`);
    total += usize;
    if (total > limits.maxTotal) throw new ZipError('解开以后太大了');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError('zip 文件坏了（文件头不对）');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + csize > buf.length) throw new ZipError('zip 文件不完整');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, limits.maxEntry) });
      } catch {
        throw new ZipError(`${path} 解压失败`);
      }
    } else throw new ZipError(`${path} 用了不支持的压缩方式（${method}）`);
    if (data.length !== usize) throw new ZipError(`${path} 解开后的大小不对`);
    if (typeof zlib.crc32 === 'function' && zlib.crc32(data) >>> 0 !== crc >>> 0) throw new ZipError(`${path} 校验不对（文件坏了）`);
    out.push({ path, data });
  }
  return out;
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}
