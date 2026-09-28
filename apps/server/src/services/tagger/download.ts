/**
 * 模型文件下载：多源测速、断点续传、sha256 校验。用户手动放进目录的文件校验通过也直接采用。
 */
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ModelSourceId } from '../../config.ts';
import { config } from '../../config.ts';
import { httpFetch } from '../../net/http.ts';
import { sha256File } from '../fs/hash.ts';
import type { ModelFile, TaggerModelSpec } from './models.ts';

export interface DownloadProgress {
  file: string;
  source: ModelSourceId;
  received: number;
  total: number;
}

interface Manifest {
  repo: string;
  files: Record<string, { sha256: string; size: number; source: ModelSourceId | 'local'; verifiedAt: string }>;
}

export function modelDir(modelsDir: string, spec: TaggerModelSpec): string {
  return path.join(modelsDir, spec.repo.replace('/', '__'));
}

export function sourceUrl(source: ModelSourceId, spec: TaggerModelSpec, file: string): string | null {
  switch (source) {
    case 'huggingface':
      return `${config.hfEndpoint}/${spec.repo}/resolve/${spec.revision}/${file}`;
    case 'hf-mirror':
      return `https://hf-mirror.com/${spec.repo}/resolve/${spec.revision}/${file}`;
    case 'modelscope':
      return spec.modelscopeRepo ? `https://www.modelscope.cn/models/${spec.modelscopeRepo}/resolve/master/${file}` : null;
  }
}

function readManifest(dir: string, repo: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    if (m.repo === repo) return m;
  } catch {
    /* 没有或损坏：当作空的 */
  }
  return { repo, files: {} };
}

/** 同步、便宜的检查（给 Pipeline 判断能否自动触发打标签）：manifest 里记录过 sha256 且磁盘大小一致 */
export function isModelReady(spec: TaggerModelSpec, modelsDir: string): boolean {
  const dir = modelDir(modelsDir, spec);
  const m = readManifest(dir, spec.repo);
  return [spec.files.model, spec.files.labels, ...(spec.files.data ? [spec.files.data] : [])].every((f) => {
    const rec = m.files[f.name];
    const p = path.join(dir, f.name);
    if (!rec || rec.sha256 !== f.sha256) return false;
    return fileSize(p) === f.size;
  });
}

/** 文件大小；不存在返回 -1 */
function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

async function probe(url: string, signal?: AbortSignal): Promise<number> {
  const t0 = performance.now();
  const s = AbortSignal.timeout(15_000);
  const res = await httpFetch(url, { headers: { range: 'bytes=0-1048575' }, signal: signal ? AbortSignal.any([s, signal]) : s });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  let n = 0;
  for await (const chunk of res.body!) {
    n += (chunk as Uint8Array).byteLength;
    if (n >= 1 << 20) break;
  }
  return n / (performance.now() - t0);
}

async function downloadOnce(url: string, part: string, total: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const have = await stat(part).then((s) => s.size, () => 0);
  if (have === total) return;
  const stall = new AbortController();
  const STALL = () => stall.abort(new Error('60 秒没有收到数据'));
  let timer = setTimeout(STALL, 60_000);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(STALL, 60_000);
  };
  try {
    const res = await httpFetch(url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
    });
    if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    // 只按 Content-Range 判断是不是续传：ModelScope 小文件会回「200 + Content-Range + 部分内容」
    const cr = /^bytes (\d+)-\d+\/\d+$/.exec(res.headers.get('content-range') ?? '');
    const start = cr ? Number(cr[1]) : 0; // 没有 Content-Range = 服务器忽略了 Range，给的是完整文件
    if (have > 0 && cr && start !== have) {
      await res.body?.cancel();
      await rm(part, { force: true });
      throw new Error(`续传位置不符：请求 ${have}，返回 ${start}`);
    }
    const append = have > 0 && start === have;
    let received = append ? have : 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        received += chunk.length;
        bump();
        onBytes(received);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(part, { flags: append ? 'a' : 'w' }));
  } finally {
    clearTimeout(timer);
  }
}

async function ensureFile(
  spec: TaggerModelSpec,
  dir: string,
  file: ModelFile,
  sources: ModelSourceId[],
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
  log: (m: string) => void = () => {},
): Promise<string> {
  const target = path.join(dir, file.name);
  const manifest = readManifest(dir, spec.repo);
  const record = async (source: ModelSourceId | 'local') => {
    manifest.files[file.name] = { sha256: file.sha256, size: file.size, source, verifiedAt: new Date().toISOString() };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  };

  // 1. 已存在（包括用户手动放置的）
  if (fileSize(target) === file.size) {
    if (manifest.files[file.name]?.sha256 === file.sha256) {
      log(`${file.name} 已存在，校验通过`);
      return target;
    }
    if ((await sha256File(target)) === file.sha256) {
      await record('local');
      log(`${file.name} 已存在（手动放置），校验通过`);
      return target;
    }
    await rename(target, `${target}.bad`);
    log(`${file.name} 校验失败，已改名为 .bad，重新下载`);
  }

  // 2. 测速
  const speeds = await Promise.all(
    sources.map(async (s) => {
      const url = sourceUrl(s, spec, file.name);
      if (!url) return null;
      try {
        const bps = await probe(url, signal);
        log(`测速 ${s}：${((bps * 1000) / 1024 / 1024).toFixed(2)} MB/s`);
        return { s, url, bps };
      } catch (err) {
        log(`测速 ${s}：失败（${(err as Error).message}）`);
        return null;
      }
    }),
  );
  const ranked = speeds.filter((x) => x !== null).sort((a, b) => b.bps - a.bps);
  if (!ranked.length) {
    throw new Error(`无法连接任何下载源（${sources.join('、')}）。可手动下载 ${file.name} 放到 ${dir}，或设置 EMAKI_HTTP_PROXY`);
  }

  // 3. 逐个源尝试，每个源最多 3 次，都能从 .part 续传
  const part = `${target}.part`;
  const errors: string[] = [];
  for (const { s, url } of ranked) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const have = await stat(part).then((x) => x.size, () => 0);
        if (have > file.size) await rm(part, { force: true });
        await downloadOnce(url, part, file.size, (received) => onProgress?.({ file: file.name, source: s, received, total: file.size }), signal);
        const size = (await stat(part)).size;
        if (size !== file.size || (await sha256File(part)) !== file.sha256) {
          await rm(part, { force: true });
          throw new Error(size !== file.size ? `大小不符：${size}` : 'sha256 不符');
        }
        await rename(part, target);
        await record(s);
        return target;
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.push(`${s} 第 ${attempt} 次：${(err as Error).message}`);
        log(errors.at(-1)!);
      }
    }
  }
  throw new Error(`下载 ${file.name} 失败：${errors.join('；')}`);
}

export async function ensureModelFiles(
  spec: TaggerModelSpec,
  modelsDir: string,
  opts: { sources?: ModelSourceId[]; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; log?: (m: string) => void } = {},
): Promise<{ dir: string; modelPath: string; labelsPath: string }> {
  const dir = modelDir(modelsDir, spec);
  await mkdir(dir, { recursive: true });
  const sources = opts.sources ?? config.modelSources;
  // 先下小文件
  const labelsPath = await ensureFile(spec, dir, spec.files.labels, sources, opts.onProgress, opts.signal, opts.log);
  // 外部权重文件（PixAI v1）：onnxruntime 按 model.onnx 里记的相对路径在同一目录找它
  if (spec.files.data) await ensureFile(spec, dir, spec.files.data, sources, opts.onProgress, opts.signal, opts.log);
  const modelPath = await ensureFile(spec, dir, spec.files.model, sources, opts.onProgress, opts.signal, opts.log);
  return { dir, modelPath, labelsPath };
}
