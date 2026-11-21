/**
 * 按姿势找图（实验，默认关）的命令和查询（docs/core-architecture.md 第 4.1 节的注册表）。
 *
 * 开关是设置 pose.enabled（settings.update）；关着时：下面除了状态、准备模型之外的查询和命令都返回 403，不跑任务，不下载。
 * 模型要用户自己准备：同意后下载（pose.downloadModels），或者从本机文件夹复制（pose.copyModels）。
 * 换了找人模型后旧的结果照常用，要重跑点「用新的找人模型重新提取」（pose.reextract）；
 * 姿势标签的低分识别时顺便收，识别过的旧图点「补充姿势标签」（pose.backfillTags）补，或者导入原型算好的（pose.importTagsLow）。
 * PoseWear 姿势目录随包，「提取姿势」时顺便匹配；骨架、标签换过和姿势库升级后「重新匹配姿势」自动补（pose.rematch 手动、all 全部重算）。
 * 线稿用户自己给（导入或 pose-covers/），没有时网页按 pose.posewearSkeleton 的骨架画小人。
 * 都是设置类（scope settings），不给 AI 助手；查询是 read。
 */
import type { PoseActionResult, PoseStatus, PoseTagsImportResult, PoseTagsStatus, PoseWearAssignResult, PoseWearImportResult, PoseWearLowResponse } from '@emaki/shared';
import { formatEta } from '@emaki/shared';
import {
  EmptyInput,
  PoseClassInput,
  PoseCopyInput,
  PoseDownloadInput,
  PoseImportInput,
  PoseRematchInput,
  PoseSimilarInput,
  PoseTagsImportInput,
  PoseWearAssignInput,
  PoseWearCatalogInput,
  PoseWearFileInput,
  PoseWearImportInput,
  PoseWearLowInput,
  PoseWearOfInput,
  PoseWearSkeletonInput,
} from '@emaki/shared/schemas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { readSettings } from '../datasource/sqlite/settings.ts';
import { posewearCatalog, posewearCounts, posewearLowIds, posewearOf, posewearSkeleton, type CoverCheck } from '../domain/pose/posewear.ts';
import { loadPoseWearAsset } from '../domain/pose/posewearAsset.ts';
import { matchCounts, matchVersion } from '../domain/pose/posewearStore.ts';
import { findCover, hasCover, type CoverDirs } from '../services/pose/covers.ts';
import { ensurePoseWearCatalog, resetMatchState } from '../services/pose/posewearMatch.ts';
import { poseTagsCounts } from '../domain/evidence/poseTags.ts';
import { poseClasses, poseCounts, poseFigure, similarPoses } from '../domain/pose/read.ts';
import { BadRequestError, HttpError, NotFoundError } from '../http/errors.ts';
import type { FileResponse } from '../infra/ports.ts';
import { ensurePoseClasses, poseReady, poseRerunRequested, requestPoseRerun } from '../services/pose/job.ts';
import { cancelPoseDownload, copyPoseModels, localPoseSource, poseDownloadState, poseModelDir, poseModelFiles, poseModelsReady, repoLabel, startPoseDownload } from '../services/pose/models.ts';
import { importPoseTagsLow, localPoseTagsNpz } from '../services/pose/poseTagsImport.ts';
import { planPoseTags, POSE_TAGS_SEC_PER_IMAGE, poseTagsRequested, requestPoseTags } from '../services/pose/tagsJob.ts';
import { importPoseWear, importPoseWearAssignments, localPoseWear, posewearDir } from '../services/pose/posewear.ts';
import { importPrototype, localPrototype } from '../services/pose/protoImport.ts';
import { defineCommand, defineQuery, type Engine } from './registry.ts';

export const poseEnabled = (e: Engine) => readSettings(e.ctx.db).pose.enabled;
const modelsReady = (e: Engine) => poseReady(e.ports.poseDetector, config.modelsDir);

/** 姿势检索关着时拒绝（403） */
export function requirePose(e: Engine): void {
  if (!poseEnabled(e)) throw new HttpError(403, 'forbidden', '姿势检索没有打开（设置 → 实验功能）');
}

const activeJob = (e: Engine, kind: 'pose' | 'pose-tags' | 'pose-match') =>
  e.ctx.jobs.list().find((j) => j.kind === kind && (j.status === 'running' || j.status === 'queued')) ?? null;

/** 线稿在哪找：导入的（数据目录）、用户放的（pose-covers/） */
const coverDirs = (e: Engine): CoverDirs => ({ imported: posewearDir(e.ctx), covers: config.poseCoversDir });
const coverCheck = (e: Engine): CoverCheck => {
  const dirs = coverDirs(e);
  return (id, view) => hasCover(dirs, id, view);
};

/** PoseWear 匹配和线稿的状态 */
function posewearMatchStatus(e: Engine): Pick<PoseStatus['posewear'], 'match' | 'covers'> {
  const asset = loadPoseWearAsset();
  const version = matchVersion(asset);
  const dirs = coverDirs(e);
  return {
    match: { version, ...matchCounts(e.ctx.db, version), job: activeJob(e, 'pose-match') },
    covers: { found: asset.poses.filter((p) => hasCover(dirs, p.id, p.bestView)).length, total: asset.poses.length, dir: config.poseCoversDir },
  };
}

/** 姿势标签低分的状态：要补多少张、补完大约多久（每张约 0.5 秒），模型不在本机的单列 */
export function poseTagsStatus(e: Engine): PoseTagsStatus {
  const t = readSettings(e.ctx.db).tagger;
  const c = poseTagsCounts(e.ctx.db, t.model);
  const plan = planPoseTags({ ctx: e.ctx, modelsDir: config.modelsDir }, t);
  const ready = plan.passes.reduce((s, p) => s + p.n, 0);
  return {
    eligible: c.eligible,
    pending: c.pending,
    missingModel: plan.missing.reduce((s, m) => s + m.n, 0),
    estimateSeconds: Math.round(ready * POSE_TAGS_SEC_PER_IMAGE),
    lowTags: c.lowTags,
    images: c.images,
    requested: poseTagsRequested(e.ctx),
    job: activeJob(e, 'pose-tags'),
    prototype: localPoseTagsNpz(),
  };
}

export function poseStatus(e: Engine): PoseStatus {
  const job = activeJob(e, 'pose');
  return {
    enabled: poseEnabled(e),
    models: {
      ready: modelsReady(e),
      dir: poseModelDir(config.modelsDir),
      files: poseModelFiles(config.modelsDir),
      localSource: localPoseSource(config.modelsDir),
      repo: repoLabel(),
      download: poseDownloadState(),
    },
    counts: poseCounts(e.ctx.db),
    rerun: poseRerunRequested(e.ctx),
    tags: poseTagsStatus(e),
    prototype: localPrototype(),
    job,
    posewear: { ...posewearCounts(e.ctx.db), defaults: localPoseWear(), ...posewearMatchStatus(e) },
  };
}

/** 设置里打开 / 关掉（settings.update 调）：打开要模型在；打开后同步类别、排一轮提取，关掉停掉任务 */
export function checkPoseToggle(e: Engine, enabled: boolean | undefined): void {
  if (enabled === true && !modelsReady(e)) throw new BadRequestError('姿势模型还没准备好：先下载或从本地复制');
}
export function afterPoseToggle(e: Engine, before: boolean, enabled: boolean | undefined): void {
  if (enabled === true && !before) {
    ensurePoseClasses(e.ctx);
    // PoseWear 姿势目录随包：同步进库；提取姿势时顺便匹配，以前提取过的（骨架、标签换过或姿势库升级了）接着补
    ensurePoseWearCatalog(e.ctx);
    e.pipeline.noteManualStart('pose');
    e.pipeline.noteManualStart('pose-match');
    e.pipeline.requestPose();
    e.pipeline.requestPoseMatch();
  }
  if (enabled === false && before) {
    for (const j of e.ctx.jobs.list())
      if ((j.kind === 'pose' || j.kind === 'pose-tags' || j.kind === 'pose-match') && (j.status === 'queued' || j.status === 'running')) e.ctx.jobs.cancel(j.id);
  }
}

export const poseCommands = [
  defineCommand({
    name: 'pose.downloadModels',
    summary: '下载姿势模型（Hugging Face deepghs/anime_person_detection 的找人模型和 yzd-v/DWPose，约 240 MB，后台进行、断点续传，进度看 pose.status）；consent 必须是 true',
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
    summary: '从本机文件夹复制姿势模型（dw-ll_ucoco_384.onnx；找人模型 model.onnx + threshold.json 在同一个文件夹或 anime_person_v1.1_m 子文件夹里），校验 sha256',
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
      // 原型没处理过的图留给任务；导进来的图接着匹配 PoseWear 姿势
      e.pipeline.requestPose();
      e.pipeline.requestPoseMatch();
      return { ...r, message: `导入了 ${r.imported} 张的姿势（归了类的 ${r.classified} 张）；图库里没有的 ${r.missing} 张、原型没处理过的 ${r.skipped} 张跳过` };
    },
  }),
  defineCommand({
    name: 'pose.importPoseWear',
    summary: '导入 PoseWear 的线稿（可选）：从本机 PoseWear 文件夹把单人姿势、双人几类互动的代表线稿复制进数据目录（再导一次会替换）；姿势目录随包，不导也能用',
    input: PoseWearImportInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/posewear/import' }],
    async run(e, input): Promise<PoseWearImportResult> {
      requirePose(e);
      const dir = path.resolve(input.path);
      if (!existsSync(dir)) throw new BadRequestError(`找不到文件夹：${dir}`);
      try {
        const r = await importPoseWear(e.ctx, dir);
        return { ...r, message: `导入了 ${r.poses} 个单人姿势、${r.pairTypes} 类双人的线稿（${r.files} 张）` };
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
    },
  }),
  defineCommand({
    name: 'pose.importPoseWearMatches',
    summary: '导入姿势匹配结果：单人（assignments_multi.json：每张图全部匹配上的姿势；旧的 assignments.json 也认）和 / 或双人（pose-pair 的 assignments.json），只导本图库里有的图，各自整批替换',
    input: PoseWearAssignInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/posewear/matches' }],
    async run(e, input): Promise<PoseWearAssignResult> {
      requirePose(e);
      if (!input.assignmentsPath && !input.pairsPath) throw new BadRequestError('单人或双人的匹配结果至少给一个');
      for (const p of [input.assignmentsPath, input.pairsPath]) if (p && !existsSync(p)) throw new BadRequestError(`找不到文件：${p}`);
      try {
        const r = await importPoseWearAssignments(e.ctx, { assignmentsPath: input.assignmentsPath, pairsPath: input.pairsPath });
        const done = [
          input.assignmentsPath && `单人 ${r.imported} 张（${r.memberships} 个图-姿势，低置信 ${r.low} 个）`,
          input.pairsPath && `双人 ${r.pairImages} 张（差分 ${r.pairVariants} 条不单独显示）`,
        ].filter(Boolean);
        const skip = [r.missing && `图库里没有的 ${r.missing} 张`, r.unknownPose && `姿势库里没有的姿势 ${r.unknownPose} 张`].filter(Boolean);
        return { ...r, message: `导入了${done.join('；')}${skip.length ? `；${skip.join('、')}跳过` : ''}` };
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
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
  defineCommand({
    name: 'pose.rematch',
    summary:
      '开始「重新匹配姿势」后台任务：按随包的 PoseWear 姿势库给提取过姿势的插画重新匹配（平时提取时就顺便匹配了；骨架、标签换过和姿势库升级后会自动补）；all=true 全部重算',
    input: PoseRematchInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/rematch' }],
    run(e, input) {
      requirePose(e);
      ensurePoseWearCatalog(e.ctx);
      if (input.all) resetMatchState(e.ctx);
      e.pipeline.noteManualStart('pose-match');
      return e.ctx.jobs.enqueue('pose-match', { requeueIfRunning: true });
    },
  }),
  defineCommand({
    name: 'pose.reextract',
    summary: '用新的找人模型重新提取：旧版本（YOLOX 找人）提取的姿势跟着「提取姿势」任务重跑；记下要求，重启后接着重提，可以取消',
    input: EmptyInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/reextract' }],
    run(e): PoseActionResult & { count: number } {
      requirePose(e);
      if (!modelsReady(e)) throw new BadRequestError('姿势模型还没准备好');
      const count = requestPoseRerun(e.ctx);
      if (!count) return { count, message: '没有用旧的找人模型提取的图' };
      e.pipeline.noteManualStart('pose');
      e.pipeline.requestPose();
      return { count, message: `开始用新的找人模型重新提取 ${count} 张` };
    },
  }),
  defineCommand({
    name: 'pose.backfillTags',
    summary: '开始「补充姿势标签」后台任务：给识别过的旧插画重跑识别模型，只收姿势标签的低分（不动标签和角色）；每张约 0.5 秒，可以取消，下次接着补',
    input: EmptyInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/tags/backfill' }],
    run(e): PoseActionResult & { count: number; estimateSeconds: number } {
      requirePose(e);
      const s = poseTagsStatus(e);
      const count = s.pending - s.missingModel;
      const skip = s.missingModel ? `；${s.missingModel} 张用的识别模型不在本机，补不了` : '';
      if (count <= 0) return { count: 0, estimateSeconds: 0, message: `没有要补的图${skip}` };
      requestPoseTags(e.ctx);
      e.pipeline.noteManualStart('pose-tags');
      e.pipeline.requestPoseTags();
      return { count, estimateSeconds: s.estimateSeconds, message: `开始补充姿势标签：${count} 张，大约 ${formatEta(s.estimateSeconds) ?? '—'}${skip}` };
    },
  }),
  defineCommand({
    name: 'pose.importTagsLow',
    summary: '导入原型算好的姿势标签低分（pose_tags_lowthr.npz）：只导本图库里有的图，已经按现在的识别模型收过的不覆盖，再导一次结果不变',
    input: PoseTagsImportInput,
    scope: 'settings',
    undoable: false,
    idempotent: true,
    http: [{ method: 'POST', path: '/api/pose/tags/import' }],
    async run(e, input): Promise<PoseTagsImportResult> {
      requirePose(e);
      if (!existsSync(input.path)) throw new BadRequestError(`找不到文件：${input.path}`);
      try {
        const r = await importPoseTagsLow(e.ctx, input.path);
        const skip = [r.missing && `图库里没有的 ${r.missing} 张`, r.skipped && `已经收过的 ${r.skipped} 张`].filter(Boolean);
        return { ...r, message: `导入了 ${r.imported} 张的姿势标签低分（${r.withTags} 张有，共 ${r.tags} 条）${skip.length ? `；${skip.join('、')}跳过` : ''}` };
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
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
    name: 'pose.posewear',
    summary: 'PoseWear 姿势库：按套、分类分好组，每个姿势计入统计的张数、线稿地址（hasCover：有没有线稿）和骨架地址；默认只给有图的姿势（all=1 全给）',
    input: PoseWearCatalogInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/posewear' }],
    run(e, q) {
      requirePose(e);
      return posewearCatalog(e.ctx.db, q.all ?? false, coverCheck(e));
    },
  }),
  defineQuery({
    name: 'pose.posewearFile',
    summary: 'PoseWear 姿势的线稿（webp；t 小图、i 大图）：导入的，或者放在 pose-covers/ 里的；都没有 404',
    input: PoseWearFileInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/posewear/:size/:file' }],
    run(e, q): FileResponse {
      requirePose(e);
      const m = /^(.+)_(front|high|low|side|diag)\.webp$/.exec(q.file)!;
      const filePath = findCover(coverDirs(e), q.size, m[1]!, m[2]!);
      if (!filePath) throw new NotFoundError('这张线稿');
      return { kind: 'path', contentType: 'image/webp', filePath };
    },
  }),
  defineQuery({
    name: 'pose.posewearSkeleton',
    summary: 'PoseWear 姿势在一个视角线稿上的骨架（随包，画小人用）：单人一个人、双人两个人，每人 23 个点 [x, y, 置信度]，坐标按线稿长边归一；view 不给用代表视角',
    input: PoseWearSkeletonInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/posewear-skeleton/:id' }],
    run(e, q) {
      requirePose(e);
      const s = posewearSkeleton(loadPoseWearAsset(), q.id, q.view);
      if (!s) throw new NotFoundError('这个姿势');
      return s;
    },
  }),
  defineQuery({
    name: 'pose.posewearOf',
    summary: '这张图匹配到的 PoseWear 姿势：主要的一个和其他全部匹配上的姿势（单人在前、双人在后，低置信的标出来）',
    input: PoseWearOfInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/posewear-match/:id' }],
    run(e, q) {
      requirePose(e);
      return posewearOf(e.ctx.db, q.id, coverCheck(e));
    },
  }),
  defineQuery({
    name: 'pose.posewearLow',
    summary: '这个 PoseWear 姿势下低置信（lowtag+skel）的图 id（网格上做记号用）',
    input: PoseWearLowInput,
    scope: 'read',
    http: [{ method: 'GET', path: '/api/pose/posewear-low/:pose' }],
    run(e, q): PoseWearLowResponse {
      requirePose(e);
      return { ids: posewearLowIds(e.ctx.db, q.pose) };
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
