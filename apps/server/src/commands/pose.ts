/**
 * 按姿势找图（实验，默认关）的命令和查询（docs/core-architecture.md 第 4.1 节的注册表）。
 *
 * 开关是设置 pose.enabled（settings.update）；关着时：下面除了状态、准备模型之外的查询和命令都返回 403，不跑任务，不下载。
 * 模型要用户自己准备：同意后下载（pose.downloadModels），或者从本机文件夹复制（pose.copyModels）。
 * 都是设置类（scope settings），不给 AI 助手；查询是 read。
 */
import type { PoseActionResult, PoseStatus } from '@emaki/shared';
import { EmptyInput, PoseClassInput, PoseCopyInput, PoseDownloadInput, PoseImportInput, PoseSimilarInput } from '@emaki/shared/schemas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { readSettings } from '../datasource/sqlite/settings.ts';
import { poseClasses, poseCounts, poseFigure, similarPoses } from '../domain/pose/read.ts';
import { BadRequestError, HttpError, NotFoundError } from '../http/errors.ts';
import type { FileResponse } from '../infra/ports.ts';
import { ensurePoseClasses, poseReady } from '../services/pose/job.ts';
import { cancelPoseDownload, copyPoseModels, localPoseSource, poseDownloadState, poseModelDir, poseModelFiles, poseModelsReady, POSE_REPO, startPoseDownload } from '../services/pose/models.ts';
import { importPrototype, localPrototype } from '../services/pose/protoImport.ts';
import { defineCommand, defineQuery, type Engine } from './registry.ts';

export const poseEnabled = (e: Engine) => readSettings(e.ctx.db).pose.enabled;
const modelsReady = (e: Engine) => poseReady(e.ports.poseDetector, config.modelsDir);

/** 姿势检索关着时拒绝（403） */
export function requirePose(e: Engine): void {
  if (!poseEnabled(e)) throw new HttpError(403, 'forbidden', '姿势检索没有打开（设置 → 实验功能）');
}

export function poseStatus(e: Engine): PoseStatus {
  const job = e.ctx.jobs.list().find((j) => j.kind === 'pose' && (j.status === 'running' || j.status === 'queued')) ?? null;
  return {
    enabled: poseEnabled(e),
    models: {
      ready: modelsReady(e),
      dir: poseModelDir(config.modelsDir),
      files: poseModelFiles(config.modelsDir),
      localSource: localPoseSource(),
      repo: POSE_REPO.repo,
      download: poseDownloadState(),
    },
    counts: poseCounts(e.ctx.db),
    prototype: localPrototype(),
    job,
  };
}

/** 设置里打开 / 关掉（settings.update 调）：打开要模型在；打开后同步类别、排一轮提取，关掉停掉任务 */
export function checkPoseToggle(e: Engine, enabled: boolean | undefined): void {
  if (enabled === true && !modelsReady(e)) throw new BadRequestError('姿势模型还没准备好：先下载或从本地复制');
}
export function afterPoseToggle(e: Engine, before: boolean, enabled: boolean | undefined): void {
  if (enabled === true && !before) {
    ensurePoseClasses(e.ctx);
    e.pipeline.noteManualStart('pose');
    e.pipeline.requestPose();
  }
  if (enabled === false && before) {
    for (const j of e.ctx.jobs.list()) if (j.kind === 'pose' && (j.status === 'queued' || j.status === 'running')) e.ctx.jobs.cancel(j.id);
  }
}

export const poseCommands = [
  defineCommand({
    name: 'pose.downloadModels',
    summary: '下载姿势模型（Hugging Face yzd-v/DWPose，约 350 MB，后台进行、断点续传，进度看 pose.status）；consent 必须是 true',
    input: PoseDownloadInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/models/download' }],
    run(): PoseActionResult {
      if (poseModelsReady(config.modelsDir)) return { message: '姿势模型已经在了' };
      return { message: startPoseDownload(config.modelsDir) ? '开始下载姿势模型' : '正在下载' };
    },
  }),
  defineCommand({
    name: 'pose.cancelDownload',
    summary: '取消正在下载的姿势模型（已下的部分留着，下次接着下）',
    input: EmptyInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'DELETE', path: '/api/pose/models/download' }],
    run: (): PoseActionResult => ({ message: cancelPoseDownload() ? '已取消下载' : '没有在下载' }),
  }),
  defineCommand({
    name: 'pose.copyModels',
    summary: '从本机文件夹复制姿势模型（yolox_l.onnx、dw-ll_ucoco_384.onnx），校验 sha256',
    input: PoseCopyInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/models/copy' }],
    async run(_e, input): Promise<PoseActionResult> {
      const dir = path.resolve(input.path);
      if (!existsSync(dir)) throw new BadRequestError(`找不到文件夹：${dir}`);
      try {
        await copyPoseModels(dir, config.modelsDir);
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
      return { message: '姿势模型已复制' };
    },
  }),
  defineCommand({
    name: 'pose.importPrototype',
    summary: '导入姿势原型跑好的数据（keypoints_lib.npz + assignments.json）：只导本图库里有的图，再导一次结果不变',
    input: PoseImportInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/import' }],
    async run(e, input): Promise<PoseActionResult & { imported: number; classified: number; missing: number; skipped: number }> {
      requirePose(e);
      for (const p of [input.keypointsPath, input.assignmentsPath]) if (!existsSync(p)) throw new BadRequestError(`找不到文件：${p}`);
      const r = await importPrototype(e.ctx, input.keypointsPath, input.assignmentsPath);
      // 原型没处理过的图留给任务
      e.pipeline.requestPose();
      return { ...r, message: `导入了 ${r.imported} 张的姿势（归了类的 ${r.classified} 张）；图库里没有的 ${r.missing} 张、原型没处理过的 ${r.skipped} 张跳过` };
    },
  }),
  defineCommand({
    name: 'pose.extract',
    summary: '开始「提取姿势」后台任务（给还没提取过的插画跑姿势模型）',
    input: EmptyInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/extract' }],
    run(e) {
      requirePose(e);
      if (!modelsReady(e)) throw new BadRequestError('姿势模型还没准备好');
      e.pipeline.noteManualStart('pose');
      return e.ctx.jobs.enqueue('pose');
    },
  }),
];

export const poseQueries = [
  defineQuery({
    name: 'pose.status',
    summary: '姿势检索：开没开、模型在不在（下载进度）、提取了多少张、正在跑的任务',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/status' }],
    run: (e) => poseStatus(e),
  }),
  defineQuery({
    name: 'pose.classes',
    summary: '姿势类别（按取景分组），每类计入统计的张数和示意小人的地址',
    input: EmptyInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/classes' }],
    run(e) {
      requirePose(e);
      return poseClasses(e.ctx.db);
    },
  }),
  defineQuery({
    name: 'pose.figure',
    summary: '姿势类别的示意小人（PNG）',
    input: PoseClassInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/classes/:id/figure.png' }],
    run(e, q): FileResponse {
      requirePose(e);
      const png = poseFigure(e.ctx.db, q.id);
      if (!png) throw new NotFoundError('这个姿势类别');
      return { kind: 'buffer', contentType: 'image/png', body: png };
    },
  }),
  defineQuery({
    name: 'pose.similar',
    summary: '和这张图姿势相近的图：同一类里按骨架距离排（镜像也算）',
    input: PoseSimilarInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/similar/:id' }],
    run(e, q) {
      requirePose(e);
      return similarPoses(e.ctx.db, q.id, q.cursor, q.limit);
    },
  }),
];
