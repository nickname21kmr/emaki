/**
 * 后台任务「补充姿势标签」（JOB_KINDS['pose-tags']，显卡道）：给识别过的旧插画重跑一遍识别模型，只收姿势标签的低分
 * （名单里分数在 [0.17, 一般标签阈值) 的，写进 image_pose_tags_low），不动标签、角色、分级。新识别的图识别时已经顺便收了。
 * 用户点了才跑（pose.backfillTags，记在 pending_work 的 pose-tags）；补完或用户取消时清掉，没补完就重启的下次接着补。
 * 每张图用它当初的识别模型（images.tagger_model，空的按设置里的模型），按模型分轮跑；本机没有的模型跳过（不自动下载）。
 * 新的在前；可以随时取消、让出，进度按张记（image_pose_tags_checked），下次接着补。
 */
import { formatEta, type Settings } from '@emaki/shared';
import type { JobContext, JobRunner } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import {
  POSE_LOW_MIN,
  POSE_TAGS,
  POSE_TAGS_FROM,
  POSE_TAGS_PENDING,
  poseTagsPendingByModel,
  writePoseTagsLow,
  type PoseLowRow,
} from '../../domain/evidence/poseTags.ts';
import { dropWork, hasWork, markWork } from '../../propagation/work.ts';
import { toAbs } from '../fs/paths.ts';
import { acquireTagger, releaseTagger, shutdownTagger, type TaggerLike, type TaggerStartOptions } from '../tagger/client.ts';
import { ensureModelFiles, isModelReady } from '../tagger/download.ts';
import { clampBatch, findModel, type TaggerModelSpec } from '../tagger/models.ts';
import type { HostItemResult } from '../tagger/protocol.ts';
import { NOT_SKIPPED, noteReadFailures, skipIds } from '../tagger/readBackoff.ts';
import { ResilientTagger } from '../tagger/resilient.ts';

/** 估算用：这台笔记本（RTX 3070 Laptop，PixAI fp16 DirectML）上每张约 0.5 秒 */
export const POSE_TAGS_SEC_PER_IMAGE = 0.5;
/** 同时在途的请求数（和画师补跑一样） */
const IN_FLIGHT = 2;

export interface PoseTagsDeps {
  ctx: SqliteContext;
  modelsDir: string;
  // 测试注入
  clientFactory?: (o: TaggerStartOptions) => Promise<TaggerLike>;
  ensureFiles?: typeof ensureModelFiles;
  isModelReady?: typeof isModelReady;
}

export interface PoseTagsPlan {
  /** 能补的：模型在本机 */
  passes: { spec: TaggerModelSpec; n: number }[];
  /** 补不了的：模型不认识或不在本机 */
  missing: { model: string; n: number }[];
}

/** 这次要跑哪几轮（按张数多的在前） */
export function planPoseTags(deps: PoseTagsDeps, t: Settings['tagger']): PoseTagsPlan {
  const ready = deps.isModelReady ?? isModelReady;
  const plan: PoseTagsPlan = { passes: [], missing: [] };
  for (const g of poseTagsPendingByModel(deps.ctx.db, t.model)) {
    const spec = findModel(g.model);
    if (spec && (deps.clientFactory || ready(spec, deps.modelsDir))) plan.passes.push({ spec, n: g.n });
    else plan.missing.push(g);
  }
  return plan;
}

export const poseTagsRequested = (ctx: SqliteContext) => hasWork(ctx.db, 'pose-tags');
export const requestPoseTags = (ctx: SqliteContext) => markWork(ctx.db, 'pose-tags', new Date(ctx.clock()).toISOString());
export const poseTagsDone = (ctx: SqliteContext) => dropWork(ctx.db, 'pose-tags');

export function createPoseTagsRunner(deps: PoseTagsDeps): JobRunner {
  const { ctx } = deps;
  const db = ctx.db;
  return async (job: JobContext) => {
    const t = readSettings(db).tagger;
    const plan = planPoseTags(deps, t);
    const total = plan.passes.reduce((s, p) => s + p.n, 0);
    const skippedNote = plan.missing.length ? `；模型不在本机、跳过 ${plan.missing.reduce((s, m) => s + m.n, 0)} 张` : '';
    job.setTotal(total);
    if (!total) return `补充姿势标签：没有要补的图${skippedNote}`;
    job.setEta?.(total * POSE_TAGS_SEC_PER_IMAGE);
    const factory = deps.clientFactory ?? acquireTagger;
    const nowIso = () => new Date(ctx.clock()).toISOString();
    let done = 0;
    let found = 0;
    const t0 = performance.now();
    const summary = () => `这次补了 ${done} 张，${found} 张有低分姿势标签`;
    for (const [k, pass] of plan.passes.entries()) {
      const spec = pass.spec;
      const tag = plan.passes.length > 1 ? `${spec.label.replace(/（.*$/, '')} · ` : '';
      job.setMessage(`补充姿势标签：${tag}检查模型文件…`);
      const files = await (deps.ensureFiles ?? ensureModelFiles)(spec, deps.modelsDir, { signal: job.signal });
      if (job.signal.aborted) return `补充姿势标签：已取消（${summary()}）`;
      job.setMessage(t.device === 'dml' ? `补充姿势标签：${tag}加载模型到显卡…` : `补充姿势标签：${tag}加载模型…`);
      const opts: TaggerStartOptions = {
        repo: spec.repo,
        modelPath: files.modelPath,
        labelsPath: files.labelsPath,
        device: t.device,
        batchSize: clampBatch(spec, t.device, t.batchSize),
        modelsDir: deps.modelsDir,
      };
      // 和画师补跑一样的出错处理：子进程崩了重开、显卡出错逐级降级、会弄崩子进程的图单独跳过
      const client = new ResilientTagger(await factory(opts), opts, factory, { signal: job.signal });
      const sel = db.prepare(
        `SELECT i.id, r.path AS root, i.rel_path AS rel ${POSE_TAGS_FROM}
         WHERE ${POSE_TAGS_PENDING} AND COALESCE(i.tagger_model, @defaultModel) = @model AND ${NOT_SKIPPED}
           AND i.id < @before ORDER BY i.id DESC LIMIT @limit`,
      );
      // 一般标签和角色门槛给到 2（不可能达到），只要姿势标签的低分；上限是现在的一般标签阈值
      const th = { general: 2, character: 2, low: { tags: POSE_TAGS, min: POSE_LOW_MIN, max: t.generalThreshold } };
      let before = Number.MAX_SAFE_INTEGER;
      let exhausted = false;
      const queue: { rows: { id: number; root: string; rel: string }[]; p: Promise<HostItemResult[]> }[] = [];
      const fill = () => {
        while (!exhausted && queue.length < IN_FLIGHT) {
          const rows = sel.all({ defaultModel: t.model, model: spec.repo, before, limit: client.current.batchSize * 4, skip: skipIds() }) as {
            id: number;
            root: string;
            rel: string;
          }[];
          if (!rows.length) {
            exhausted = true;
            break;
          }
          before = rows.at(-1)!.id;
          const p = client.tag(
            rows.map((r) => ({ id: r.id, path: toAbs(r.root, r.rel) })),
            th,
          );
          p.catch(() => undefined); // 轮到它时再处理；取消、让出时没等的请求不算未处理的拒绝
          queue.push({ rows, p });
        }
      };
      try {
        for (;;) {
          if (job.signal.aborted) return `补充姿势标签：已取消（${summary()}）`;
          if (job.shouldYield()) {
            // 还在途的不写，下次接着补时会重新挑到
            job.requeue();
            return `补充姿势标签：已让出（${summary()}）`;
          }
          fill();
          const head = queue.shift();
          if (!head) break;
          let results: HostItemResult[];
          try {
            results = await head.p;
          } catch (err) {
            if (job.signal.aborted) return `补充姿势标签：已取消（${summary()}）`;
            throw err;
          }
          fill(); // 先把下一批发出去，再写库
          noteReadFailures(results);
          const rows: PoseLowRow[] = [];
          for (const r of results) {
            // 文件不在了的留给扫描器，暂时读不了的下次再试；解不开的记收集过，不再反复卡在它上面
            if (!r.ok && (r.code === 'ENOENT' || r.code === 'IO')) continue;
            const low = r.ok ? (r.low ?? []) : [];
            rows.push({ imageId: r.id, model: spec.repo, low });
          }
          db.transaction(() => writePoseTagsLow(db, rows, t.generalThreshold, nowIso()))();
          found += rows.filter((r) => r.low.length).length;
          done += head.rows.length;
          const rate = done / ((performance.now() - t0) / 1000);
          const left = (total - done) / rate;
          job.setEta?.(left);
          job.advance(head.rows.length, `补充姿势标签：${tag}${done} / ${total} · ${rate.toFixed(1)} 张/秒 · 剩余约 ${formatEta(left) ?? '—'}`);
        }
      } finally {
        client.close();
        if (!deps.clientFactory) {
          // 换模型的轮次之间立刻释放（两个大模型同时占显存会爆）；最后一轮照旧空闲 60 秒后关
          if (k < plan.passes.length - 1) await shutdownTagger();
          else releaseTagger();
        }
      }
    }
    return `补充姿势标签：${summary()}${skippedNote}`;
  };
}

/** 给 Pipeline 的阶段：姿势检索打开了、用户要求了、还有能补的才自动续跑 */
export function createPoseTagsStage(deps: PoseTagsDeps) {
  const db = deps.ctx.db;
  return {
    enabled: () => readSettings(db).pose.enabled,
    requested: () => poseTagsRequested(deps.ctx),
    pendingCount: () => planPoseTags(deps, readSettings(db).tagger).passes.reduce((s, p) => s + p.n, 0),
    done: () => poseTagsDone(deps.ctx),
    run: createPoseTagsRunner(deps),
  };
}
