/**
 * 姿势模型文件，都从 Hugging Face 下载、固定修订号、sha256 校验：
 * - 找人：deepghs/anime_person_detection 的 person_detect_v1.1_m（YOLOv8m，只有「人」一类，MIT），model.onnx + threshold.json；
 *   放在 <modelsDir>/deepghs__anime_person_detection/person_detect_v1.1_m/。动漫图上比 YOLOX 找得全，重叠的两个人也分得开。
 * - 骨架：yzd-v/DWPose 的 DWPose-L（全身 133 点，Apache-2.0），放在 <modelsDir>/yzd-v__DWPose/。
 * 以前找人用同一个仓库里的 YOLOX-L（yolox_l.onnx），2026-11-21 换掉了；已经下载的 yolox_l.onnx 不删，也不再用。
 * 和识别模型同一套 manifest（sha256 校验过的才记）。下载要用户点同意（pose.downloadModels），
 * 也可以从本机文件夹复制（pose.copyModels），复制后同样校验 sha256。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ModelSourceId } from '../../config.ts';
import { sha256File } from '../fs/hash.ts';
import { ensureFile, modelDir, type DownloadProgress, type RepoSpec } from '../tagger/download.ts';
import type { ModelFile } from '../tagger/models.ts';
import type { PoseDownloadState } from '@emaki/shared';

export const POSE_REPO: RepoSpec = { repo: 'yzd-v/DWPose', revision: '1a7144101628d69ee7a3768d1ee3a094070dc388', modelscopeRepo: null };
export const DET_REPO: RepoSpec = { repo: 'deepghs/anime_person_detection', revision: 'e39c744c22432ad01f91dd254fe2b02c8d878b8c', modelscopeRepo: null };

/** name 是仓库里的路径（找人模型在子文件夹里） */
export const POSE_FILES = {
  detector: { name: 'person_detect_v1.1_m/model.onnx', size: 103_459_671, sha256: 'c80365a98ca8388fd2f01fd5abea0439e92265bceceb048bef38b0849303467c' },
  threshold: { name: 'person_detect_v1.1_m/threshold.json', size: 48, sha256: 'cac26a21ee327f0d270bc5704eb31ec7fbcdfc97a3accef294acc05b41950839' },
  dwpose: { name: 'dw-ll_ucoco_384.onnx', size: 134_399_116, sha256: '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843' },
} as const satisfies Record<string, ModelFile>;

interface Entry {
  repo: RepoSpec;
  file: ModelFile;
}
const ENTRIES: Entry[] = [
  { repo: DET_REPO, file: POSE_FILES.detector },
  { repo: DET_REPO, file: POSE_FILES.threshold },
  { repo: POSE_REPO, file: POSE_FILES.dwpose },
];

/** 找人的分数门槛：threshold.json 里的（这个模型 F1 最好的点），文件读不了时用它 */
export const DET_THRESHOLD = 0.348;
/** 只有 Hugging Face 和它的镜像上有（ModelScope 没有这两个仓库） */
const SOURCES: ModelSourceId[] = ['huggingface', 'hf-mirror'];
/** 原型目录：开发机上有就给「从本地复制」做默认值（找人模型在 anime_person_v1.1_m 子文件夹里） */
const LOCAL_CANDIDATES = ['F:/Claude/.work/pose-proto/models'];
/** 复制时找人模型可以在这些子文件夹里，也可以就在选的文件夹里 */
const DET_SUBDIRS = ['person_detect_v1.1_m', 'anime_person_v1.1_m', ''];

export const repoLabel = () => [DET_REPO.repo, POSE_REPO.repo].join('、');

export function poseModelDir(modelsDir: string): string {
  return modelDir(modelsDir, POSE_REPO);
}

const target = (modelsDir: string, e: Entry) => path.join(modelDir(modelsDir, e.repo), e.file.name);

export function poseModelPaths(modelsDir: string) {
  const det = modelDir(modelsDir, DET_REPO);
  return {
    dir: poseModelDir(modelsDir),
    detectorPath: path.join(det, POSE_FILES.detector.name),
    thresholdPath: path.join(det, POSE_FILES.threshold.name),
    dwposePath: path.join(poseModelDir(modelsDir), POSE_FILES.dwpose.name),
  };
}

const sizeOf = (p: string) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

/** 便宜的检查（状态、开关用）：文件都在、大小对；sha256 在下载、复制时校验过 */
export function poseModelFiles(modelsDir: string): { name: string; size: number; present: boolean }[] {
  return ENTRIES.map((e) => ({ name: e.file.name, size: e.file.size, present: sizeOf(target(modelsDir, e)) === e.file.size }));
}

export const poseModelsReady = (modelsDir: string) => poseModelFiles(modelsDir).every((f) => f.present);

/** threshold.json 里的门槛；读不了用 DET_THRESHOLD */
export function readDetThreshold(modelsDir: string): number {
  try {
    const v = (JSON.parse(readFileSync(poseModelPaths(modelsDir).thresholdPath, 'utf8')) as { threshold?: unknown }).threshold;
    return typeof v === 'number' && v > 0 && v < 1 ? v : DET_THRESHOLD;
  } catch {
    return DET_THRESHOLD;
  }
}

/** 本机文件夹里的这个文件（大小对上才算）；找人模型的两个文件按 DET_SUBDIRS 找 */
function localFile(from: string, e: Entry): string | null {
  const base = path.posix.basename(e.file.name);
  for (const sub of e.repo === DET_REPO ? DET_SUBDIRS : ['']) {
    const p = path.join(from, sub, base);
    if (sizeOf(p) === e.file.size) return p;
  }
  return null;
}

/** 本机能直接复制的文件夹：缺的文件在里面都找得到（已经装好的不用） */
export function localPoseSource(modelsDir?: string): string | null {
  const have = (e: Entry) => modelsDir !== undefined && sizeOf(target(modelsDir, e)) === e.file.size;
  for (const d of LOCAL_CANDIDATES) {
    const found = ENTRIES.map((e) => localFile(d, e) !== null);
    if (found.some(Boolean) && ENTRIES.every((e, k) => found[k] || have(e))) return d;
  }
  return null;
}

/** 从 Hugging Face 下载（测速、断点续传、sha256 校验，和识别模型同一套）；已经在的不再下 */
export async function downloadPoseModels(
  modelsDir: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; log?: (m: string) => void } = {},
): Promise<void> {
  for (const e of ENTRIES) {
    await mkdir(path.dirname(target(modelsDir, e)), { recursive: true });
    await ensureFile(e.repo, modelDir(modelsDir, e.repo), e.file, SOURCES, opts.onProgress, opts.signal, opts.log);
  }
}

/** 从本机文件夹复制：先复制成 .part，校验 sha256 再改名；再经 ensureFile 记进 manifest（不会联网：文件已经在了） */
export async function copyPoseModels(from: string, modelsDir: string): Promise<void> {
  for (const e of ENTRIES) {
    const dir = modelDir(modelsDir, e.repo);
    const dest = target(modelsDir, e);
    if (sizeOf(dest) !== e.file.size) {
      const src = localFile(from, e);
      if (!src || !existsSync(src)) throw new Error(`${from} 里没有 ${path.posix.basename(e.file.name)}（${e.repo.repo}）`);
      await mkdir(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      await copyFile(src, part);
      if (sizeOf(part) !== e.file.size || (await sha256File(part)) !== e.file.sha256) {
        await rm(part, { force: true });
        throw new Error(`${path.posix.basename(e.file.name)} 校验失败（不是 ${e.repo.repo} 的那个文件）`);
      }
      await rename(part, dest);
    }
    await ensureFile(e.repo, dir, e.file, []);
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
