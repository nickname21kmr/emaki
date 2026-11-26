/** Read downloader frame manifests as data; the HTML's JavaScript is never run. */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Buffer } from '../fs/hash.ts';
import { writeFileAtomic } from '../fs/atomicWrite.ts';
import { sharp, SHARP_INPUT } from './sharpConfig.ts';

const MAX_HTML = 128 * 1024 * 1024;
/**
 * 整段动画（宽 × 高 × 帧数）最多这么多像素：约是 1920×1080 的 500 帧。以前是 6400 万（一次解码全部帧，要 256 MiB 内存），
 * 帧多、尺寸大的 Pixiv 动图都被拒在图库外面；现在分段编码（CHUNK_PIXELS），内存只看一段
 */
const MAX_PIXELS = 1024 * 1024 * 1024;
/** 不超过这么多像素时，播放用的 WebP 是无损的（和原来一样）；更大的用有损——原文件不动，无损的又大又慢（2026-11-26 实测大 5 倍、慢 6 倍） */
const LOSSLESS_PIXELS = 64 * 1024 * 1024;
const LOSSY_QUALITY = 90;
/** 一次编码多少像素的帧（RGBA 64 MiB）：全高清是 8 帧一段 */
const CHUNK_PIXELS = 16 * 1024 * 1024;
const MANIFEST = /\b(?:var|let|const)\s+frames_info\s*=\s*(\[[\s\S]*?\])\s*(?:;|<\/script>|(?:\r?\n|$))/i;
export const isHtmlFile = (file: string) => /\.html?$/i.test(file);

export function looksLikeHtmlAnimation(input: Buffer): boolean {
  const head = input.subarray(0, 65536).toString('utf8');
  return /<(?:!doctype\s+html|html)\b/i.test(head) && /\b(?:var|let|const)\s+frames_info\s*=\s*\[/.test(head);
}

interface Frame { file: string; delay: number }
export function parseHtmlAnimation(input: Buffer): Frame[] {
  if (input.length > MAX_HTML) throw new Error('HTML 动图超过 128 MiB');
  if (!looksLikeHtmlAnimation(input)) throw new Error('未识别的 HTML 动图结构');
  const match = MANIFEST.exec(input.toString('utf8'));
  if (!match) throw new Error('HTML 动图缺少可读取的帧列表');
  const frames: unknown = JSON.parse(match[1]!);
  if (!Array.isArray(frames) || !frames.length || frames.length > 1000) throw new Error('HTML 动图帧数需为 1–1000');
  let duration = 0;
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || typeof frame.file !== 'string' ||
      !/^data:(?:application\/octet-stream|image\/(?:jpeg|png|webp));base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.file) ||
      !Number.isInteger(frame.delay) || frame.delay < 1 || frame.delay > 60000) throw new Error('HTML 动图帧数据或播放间隔无效');
    duration += frame.delay;
  }
  if (duration > 600000) throw new Error('HTML 动图时长超过 10 分钟');
  return frames as Frame[];
}

function frameBuffer(frame: Frame): Buffer {
  const bytes = Buffer.from(frame.file.slice(frame.file.indexOf(',') + 1), 'base64');
  // Only raster images: a declared data URI is not sufficient to accept SVG/HTML.
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8) &&
    !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    !(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP')) throw new Error('HTML 动图只支持 JPEG、PNG 或 WebP 图片帧');
  return bytes;
}

export const htmlAnimationFirstFrame = (input: Buffer): Buffer => frameBuffer(parseHtmlAnimation(input)[0]!);

export async function probeHtmlAnimation(input: Buffer) {
  const frames = parseHtmlAnimation(input);
  const m = await sharp(frameBuffer(frames[0]!), SHARP_INPUT).metadata();
  const width = m.width!, height = m.height!;
  if (!width || !height || width * height * frames.length > MAX_PIXELS) throw new Error('HTML 动图解码尺寸过大');
  return {format:'html' as const,width,height,pages:frames.length,camera:''};
}

const inflight = new Map<string, Promise<string>>();
export async function htmlAnimationCache(input: Buffer, dataDir: string, sha = sha256Buffer(input)): Promise<string> {
  const file = path.join(dataDir, 'animations', 'v1', sha.slice(0,2), `${sha}.webp`);
  if (existsSync(file)) return file;
  let pending = inflight.get(file);
  if (!pending) {
    pending = convert(input,file).finally(() => inflight.delete(file));
    inflight.set(file,pending);
  }
  return pending;
}

async function convert(input: Buffer, file: string): Promise<string> {
  const {width,height} = await probeHtmlAnimation(input);
  const frames = parseHtmlAnimation(input);
  const webp = await encodeAnimation(frames.map((f) => () => frameBuffer(f)), frames.map((f) => f.delay), width, height);
  await writeFileAtomic(file,webp);
  return file;
}

/**
 * 一帧一帧的图 → 动态 WebP。分段编码再把各段的帧接起来：sharp 拼帧时会把解码出来的帧一直留到编码完，
 * 整段一次编码时内存跟帧数一起涨。o 只给测试用（小图也能分段、走有损）
 */
export async function encodeAnimation(
  frames: readonly (() => Buffer)[],
  delays: readonly number[],
  width: number,
  height: number,
  { chunkPixels = CHUNK_PIXELS, losslessPixels = LOSSLESS_PIXELS }: { chunkPixels?: number; losslessPixels?: number } = {},
): Promise<Buffer> {
  const lossless = width * height * frames.length <= losslessPixels;
  const per = Math.max(1, Math.floor(chunkPixels / (width * height)));
  const parts: Buffer[] = [];
  // 各段共用一块（大小按一段算）：每段新分配的话，旧的要等垃圾回收才还，帧多时内存一路涨（实测 160 帧全高清多出 680 MB）
  const buffer = Buffer.alloc(width * height * 4 * Math.min(per, frames.length));
  for (let start = 0; start < frames.length; start += per) {
    const count = Math.min(per, frames.length - start);
    const raw = buffer.subarray(0, width * height * 4 * count);
    for (let i = 0; i < count; i++) {
      const image = sharp(frames[start + i]!(), SHARP_INPUT);
      const m = await image.metadata();
      if (m.width !== width || m.height !== height || (m.pages ?? 1) !== 1) throw new Error('HTML 动图各帧尺寸需一致，且每帧应为静态图片');
      const pixels = await image.ensureAlpha().toColourspace('srgb').raw().toBuffer();
      pixels.copy(raw,i * width * height * 4);
    }
    parts.push(await sharp(raw,{raw:{width,height:height * count,channels:4,pageHeight:height}})
      .webp({...(lossless ? {lossless:true,effort:3} : {quality:LOSSY_QUALITY,effort:4}),loop:0,delay:delays.slice(start,start + count)})
      .toBuffer());
  }
  return parts.length === 1 ? parts[0]! : joinAnimatedWebp(parts, delays, width, height, per);
}

/** WebP 容器（RIFF）里的块 */
function riffChunks(webp: Buffer): { id: string; data: Buffer }[] {
  if (webp.toString('ascii',0,4) !== 'RIFF' || webp.toString('ascii',8,12) !== 'WEBP') throw new Error('不是 WebP');
  const out: { id: string; data: Buffer }[] = [];
  for (let p = 12; p + 8 <= webp.length;) {
    const size = webp.readUInt32LE(p + 4);
    out.push({ id: webp.toString('ascii',p,p + 4), data: webp.subarray(p + 8,p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}

function riffChunk(id: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id,0,'ascii');
  head.writeUInt32LE(data.length,4);
  return Buffer.concat(data.length & 1 ? [head,data,Buffer.alloc(1)] : [head,data]);
}

const uint24 = (n: number) => Buffer.from([n & 0xff,(n >> 8) & 0xff,(n >> 16) & 0xff]);

/**
 * 几段动态 WebP 接成一段（WebP 容器规范的 VP8X、ANIM、ANMF）：每段的帧原样接上，每段的第一帧是整张画面，
 * 标成「不和上一帧混合」，播放出来和每段单独播放时一样。只有一帧的段编出来是静态图，包成一帧
 */
function joinAnimatedWebp(parts: Buffer[], delays: readonly number[], width: number, height: number, per: number): Buffer {
  const frames: Buffer[] = [];
  let anim: Buffer | null = null;
  let alpha = false;
  for (const [index,part] of parts.entries()) {
    const chunks = riffChunks(part);
    const vp8x = chunks.find((c) => c.id === 'VP8X');
    if (vp8x && vp8x.data[0]! & 0x10) alpha = true;
    anim ??= chunks.find((c) => c.id === 'ANIM')?.data ?? null;
    const anmf = chunks.filter((c) => c.id === 'ANMF');
    if (anmf.length) {
      for (const [i,f] of anmf.entries()) {
        const frame = Buffer.from(f.data);
        if (i === 0) frame[15] = frame[15]! | 0x02; // 不混合
        frames.push(frame);
      }
    } else {
      const image = chunks.filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
      const vp8l = image.find((c) => c.id === 'VP8L');
      // 无损的透明信息在 VP8L 头里（签名之后 32 位的第 28 位）
      if (image.some((c) => c.id === 'ALPH') || (vp8l && (vp8l.data.readUInt32LE(1) >>> 28) & 1)) alpha = true;
      const head = Buffer.concat([uint24(0),uint24(0),uint24(width - 1),uint24(height - 1),uint24(delays[index * per]!),Buffer.from([0x02])]);
      frames.push(Buffer.concat([head,...image.map((c) => riffChunk(c.id,c.data))]));
    }
  }
  const vp8x = Buffer.concat([Buffer.from([0x02 | (alpha ? 0x10 : 0),0,0,0]),uint24(width - 1),uint24(height - 1)]);
  // 背景色白、无限循环（和 sharp 的 loop: 0 一样）
  const body = Buffer.concat([
    Buffer.from('WEBP','ascii'),
    riffChunk('VP8X',vp8x),
    riffChunk('ANIM',anim ?? Buffer.from([0xff,0xff,0xff,0xff,0,0])),
    ...frames.map((f) => riffChunk('ANMF',f)),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF',0,'ascii');
  head.writeUInt32LE(body.length,4);
  return Buffer.concat([head,body]);
}

export async function readHtmlAnimation(file: string): Promise<Buffer> {
  if ((await stat(file)).size > MAX_HTML) throw new Error('HTML 动图超过 128 MiB');
  return readFile(file);
}
