/**
 * 姿势模型文件：YOLOX-L（找人）和 DWPose-L（全身 133 点），都来自 Hugging Face yzd-v/DWPose（Apache-2.0），固定修订号。
 * 放在 <modelsDir>/yzd-v__DWPose/，和识别模型同一套 manifest（sha256 校验过的才记）。
 * 下载要用户点同意（pose.downloadModels），也可以从本机文件夹复制（pose.copyModels），复制后同样校验 sha256。
 */
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ModelSourceId } from '../../config.ts';
import { sha256File } from '../fs/hash.ts';
import { ensureFile, modelDir, type DownloadProgress, type RepoSpec } from '../tagger/download.ts';
import type { ModelFile } from '../tagger/models.ts';
import type { PoseDownloadState } from '@emaki/shared';

export const POSE_REPO: RepoSpec = { repo: 'yzd-v/DWPose', revision: '1a7144101628d69ee7a3768d1ee3a094070dc388', modelscopeRepo: null };

export const POSE_FILES = {
  yolox: { name: 'yolox_l.onnx', size: 216_746_733, sha256: '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411' },
  dwpose: { name: 'dw-ll_ucoco_384.onnx', size: 134_399_116, sha256: '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843' },
} as const satisfies Record<string, ModelFile>;

const FILES: ModelFile[] = [POSE_FILES.yolox, POSE_FILES.dwpose];
/** 只有 Hugging Face 和它的镜像上有（ModelScope 没有这个仓库） */
const SOURCES: ModelSourceId[] = ['huggingface', 'hf-mirror'];
/** 原型目录：开发机上有就给「从本地复制」做默认值 */
const LOCAL_CANDIDATES = ['F:/Claude/.work/pose-proto/models'];

export function poseModelDir(modelsDir: string): string {
  return modelDir(modelsDir, POSE_REPO);
}

export function poseModelPaths(modelsDir: string) {
  const dir = poseModelDir(modelsDir);
  return { dir, yoloxPath: path.join(dir, POSE_FILES.yolox.name), dwposePath: path.join(dir, POSE_FILES.dwpose.name) };
}

const sizeOf = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/** 便宜的检查（状态、开关用）：两个文件都在、大小对；sha256 在下载、复制时校验过 */
export function poseModelFiles(modelsDir: string): { name: string; size: number; present: boolean }[] {
  const dir = poseModelDir(modelsDir);
  return FILES.map((f) => ({ name: f.name, size: f.size, present: sizeOf(path.join(dir, f.name)) === f.size }));
}

export const poseModelsReady = (modelsDir: string) => poseModelFiles(modelsDir).every((f) => f.present);

/** 本机能直接复制的文件夹（两个文件大小都对上） */
export function localPoseSource(): string | null {
  for (const d of LOCAL_CANDIDATES) if (FILES.every((f) => sizeOf(path.join(d, f.name)) === f.size)) return d;
  return null;
}

/** 从 Hugging Face 下载（测速、断点续传、sha256 校验，和识别模型同一套） */
export async function downloadPoseModels(
  modelsDir: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; log?: (m: string) => void } = {},
): Promise<void> {
  const dir = poseModelDir(modelsDir);
  await mkdir(dir, { recursive: true });
  for (const f of FILES) await ensureFile(POSE_REPO, dir, f, SOURCES, opts.onProgress, opts.signal, opts.log);
}

/** 从本机文件夹复制：先复制成 .part，校验 sha256 再改名；再经 ensureFile 记进 manifest（不会联网：文件已经在了） */
export async function copyPoseModels(from: string, modelsDir: string): Promise<void> {
  const dir = poseModelDir(modelsDir);
  await mkdir(dir, { recursive: true });
  for (const f of FILES) {
    const src = path.join(from, f.name);
    if (!existsSync(src)) throw new Error(`${from} 里没有 ${f.name}`);
    const target = path.join(dir, f.name);
    if (sizeOf(target) !== f.size) {
      const part = `${target}.part`;
      await copyFile(src, part);
      if (sizeOf(part) !== f.size || (await sha256File(part)) !== f.sha256) {
        await rm(part, { force: true });
        throw new Error(`${f.name} 校验失败（不是 yzd-v/DWPose 的那个文件）`);
      }
      await rename(part, target);
    }
    await ensureFile(POSE_REPO, dir, f, []);
  }
}

// ---------------------------------------------------------------- 后台下载（同意后开始，进度在 pose.status 里）

let download: PoseDownloadState = { state: 'idle', file: null, received: 0, total: 0, message: null };
let abort: AbortController | null = null;

export const poseDownloadState = (): PoseDownloadState => ({ ...download });

/** 开始下载（已经在下就什么也不做）；返回是不是这次开始的 */
export function startPoseDownload(modelsDir: string, onDone?: () => void): boolean {
  if (download.state === 'running') return false;
  abort = new AbortController();
  const signal = abort.signal;
  download = { state: 'running', file: null, received: 0, total: 0, message: '准备下载…' };
  void downloadPoseModels(modelsDir, {
    signal,
    onProgress: (p) => (download = { ...download, file: p.file, received: p.received, total: p.total, message: `下载 ${p.file}（${p.source}）` }),
    log: (m) => (download = { ...download, message: m }),
  }).then(
    () => {
      download = { ...download, state: 'done', message: '下载完成' };
      onDone?.();
    },
    (err: Error) => (download = { ...download, state: signal.aborted ? 'cancelled' : 'failed', message: signal.aborted ? '已取消（下次接着下）' : err.message }),
  );
  return true;
}

export function cancelPoseDownload(): boolean {
  if (download.state !== 'running') return false;
  abort?.abort();
  return true;
}
