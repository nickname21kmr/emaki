/** Read downloader frame manifests as data; the HTML's JavaScript is never run. */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Buffer } from '../fs/hash.ts';
import { writeFileAtomic } from '../fs/atomicWrite.ts';
import { sharp, SHARP_INPUT } from './sharpConfig.ts';

const MAX_HTML = 128 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024; // entire decoded RGBA animation <= 256 MiB
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
  const raw = Buffer.alloc(width * height * 4 * frames.length);
  for (const [index,frame] of frames.entries()) {
    const image = sharp(frameBuffer(frame), SHARP_INPUT);
    const m = await image.metadata();
    if (m.width !== width || m.height !== height || (m.pages ?? 1) !== 1) throw new Error('HTML 动图各帧尺寸需一致，且每帧应为静态图片');
    const pixels = await image.ensureAlpha().toColourspace('srgb').raw().toBuffer();
    pixels.copy(raw,index * width * height * 4);
  }
  const webp = await sharp(raw,{raw:{width,height:height * frames.length,channels:4,pageHeight:height}})
    .webp({lossless:true,loop:0,delay:frames.map(f=>f.delay),effort:3}).toBuffer();
  await writeFileAtomic(file,webp);
  return file;
}

export async function readHtmlAnimation(file: string): Promise<Buffer> {
  if ((await stat(file)).size > MAX_HTML) throw new Error('HTML 动图超过 128 MiB');
  return readFile(file);
}
