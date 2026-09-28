/**
 * 生成测试图库（T04、T16、T18、T24 共用）。
 *   npx tsx apps/server/scripts/make-fixtures.ts <dir>
 *
 * 安全规则：目录不存在 → 创建；存在且有标记文件 .emaki-fixtures → 清空重建；
 * 存在、没有标记文件、又不为空 → 报错退出（防止误删用户的图）。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sharp } from '../src/services/image/sharpConfig.ts';

const MARKER = '.emaki-fixtures';
const dir: string = process.argv[2] ?? '';
if (!dir) {
  console.error('用法：npx tsx apps/server/scripts/make-fixtures.ts <dir>');
  process.exit(1);
}

if (existsSync(dir)) {
  const entries = await readdir(dir);
  if (entries.length && !entries.includes(MARKER)) {
    console.error(`拒绝操作：${dir} 不是空目录，也不是之前生成的测试图库（没有 ${MARKER}）`);
    process.exit(1);
  }
  await rm(dir, { recursive: true, force: true });
}
await mkdir(dir, { recursive: true });

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 带纹理的 raw RGB：正弦条纹 + 噪声，方向 / 频率 / 相位都由 seed 决定（纯色图的 dHash 没有意义） */
function makePattern(seed: number, w: number, h: number): Buffer {
  const r = mulberry32(seed);
  const angle = r() * Math.PI;
  const freq = 0.01 + r() * 0.05;
  const phase = r() * Math.PI * 2;
  const [cr, cg, cb] = [r(), r(), r()].map((x) => 60 + x * 180) as [number, number, number];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.sin((x * dx + y * dy) * freq + phase) * 0.5 + 0.5;
      const v2 = Math.sin((x * dy - y * dx) * freq * 0.37 + phase * 2) * 0.5 + 0.5;
      const noise = (r() - 0.5) * 20;
      const i = (y * w + x) * 3;
      buf[i] = Math.max(0, Math.min(255, cr * v + 40 * v2 + noise));
      buf[i + 1] = Math.max(0, Math.min(255, cg * (1 - v) + 60 * v2 + noise));
      buf[i + 2] = Math.max(0, Math.min(255, cb * v2 + noise));
    }
  }
  return buf;
}

const PATTERN = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9 } as const;
const img = (seed: number, w: number, h: number) => sharp(makePattern(seed, w, h), { raw: { width: w, height: h, channels: 3 } });

const written: string[] = [];
async function put(rel: string, data: Buffer | Promise<Buffer>) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, await data);
  written.push(abs);
}
async function copy(fromRel: string, toRel: string) {
  const to = path.join(dir, toRel);
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(path.join(dir, fromRel), to);
  written.push(to);
}

/** 手写 24 位 BMP（54 字节头，行 4 字节对齐，BGR，自下而上）；预编译 sharp 不支持 BMP */
function makeBmp(seed: number, w: number, h: number): Buffer {
  const rgb = makePattern(seed, w, h);
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      buf[row + x * 3] = rgb[s + 2]!;
      buf[row + x * 3 + 1] = rgb[s + 1]!;
      buf[row + x * 3 + 2] = rgb[s]!;
    }
  }
  return buf;
}

// 没写图案的每一项都用自己独有的种子 100 + 序号
await put('pixiv/123456789_p0.png', img(PATTERN.A, 800, 1200).png().toBuffer()); // 1
await put('pixiv/123456789_p1.png', img(PATTERN.B, 1200, 800).png().toBuffer()); // 2
await put('pixiv/98765432 someuser/98765432_p0.jpg', img(PATTERN.C, 900, 1200).jpeg({ quality: 90 }).toBuffer()); // 3
await copy('pixiv/98765432 someuser/98765432_p0.jpg', 'copies/98765432_p0 - 副本.jpg'); // 4 完全重复
await copy('pixiv/123456789_p0.png', 'copies/123456789_p0 (1).png'); // 5 完全重复
await put('copies/resized_A.jpg', img(PATTERN.A, 800, 1200).resize(400, 600).jpeg({ quality: 85 }).toBuffer()); // 6 相似
await put('twitter/someartist/1789012345678901234_1.jpg', img(PATTERN.D, 1200, 900).jpeg().toBuffer()); // 7
await put('twitter/someartist-1789012345678901234-20250101_120000-img1.jpg', img(PATTERN.E, 1000, 1000).jpeg().toBuffer()); // 8
await put('twitter/GJnJQvHbwAAoY3S.jpg_large', img(PATTERN.F, 1200, 675).jpeg().toBuffer()); // 9
await put(
  'downloads/__hatsune_miku_vocaloid_drawn_by_foo_bar__0123456789abcdef0123456789abcdef.jpg',
  img(PATTERN.G, 850, 1200).jpeg().toBuffer(),
); // 10
{
  // 11 RGBA，右半透明
  const w = 600;
  const h = 600;
  const rgb = makePattern(111, w, h);
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgb[i * 3]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = i % w < w / 2 ? 255 : 0;
  }
  await put('alpha/transparent.png', sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer());
}
await put('tall/strip.png', img(112, 800, 20000).png().toBuffer()); // 12
{
  // 13 截断的 JPEG：文件头完整，能入库；独立图案 H，避免和 #3 连成相似组
  const full = await img(PATTERN.H, 1200, 1200).jpeg().toBuffer();
  await put('broken/truncated.jpg', full.subarray(0, Math.floor(full.length * 0.6)));
}
await put('中文 目录/插画, 测试 [1].png', img(114, 700, 1000).png().toBuffer()); // 14
{
  // 15 绝对路径超过 260 字符
  const deep = Array.from({ length: 6 }, (_, i) => `很长的目录名_${i}_${'x'.repeat(40)}`).join('/');
  await put(`deep/${deep}/long.png`, img(115, 400, 600).png().toBuffer());
}
await put('legacy/image.jfif', img(116, 800, 1100).jpeg().toBuffer()); // 16
await put('gif/still.gif', img(117, 500, 500).gif().toBuffer()); // 17
await put('avif/test.avif', img(118, 640, 960).avif({ quality: 60 }).toBuffer()); // 18
await put('bmp/test.bmp', makeBmp(119, 300, 200)); // 19
const expectedImages = written.length;

// 应报错
await put('broken/fake.png', Buffer.from('这不是一张图片\n'));
// 应被跳过
await put('.hidden/secret.png', img(201, 100, 100).png().toBuffer());
await put('$RECYCLE.BIN/x.png', img(202, 100, 100).png().toBuffer());
await put('misc/readme.txt', Buffer.from('readme'));
await put('misc/empty.png', Buffer.alloc(0));

// 把时间拨到过去：否则扫描器的「2 秒内刚修改 → 延后」规则会跳过它们
for (const [i, f] of written.entries()) {
  const t = new Date(Date.now() - 3_600_000 - i * 60_000);
  await utimes(f, t, t);
}
await writeFile(path.join(dir, MARKER), '由 make-fixtures.ts 生成，可以放心删除\n');
console.log(`已生成测试图库：${dir}`);
console.log(`应入库 ${expectedImages} 张，应报错 1 个`);
