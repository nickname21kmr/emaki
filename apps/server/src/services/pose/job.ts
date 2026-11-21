/**
 * 后台任务「提取姿势」（JOB_KINDS.pose，显卡道）：给计入统计、还没提取过的插画找人、跑 DWPose，
 * 挑主要人物、分取景、归到最近的姿势类别（domain/pose/features.ts），写进 image_poses。
 * 旧版本（旧的找人模型）提取的不自动重跑：用户点了「用新的找人模型重新提取」（pending_work 的 pose-rerun）才一起跑，
 * 旧的都重提完了清掉这个标记。新的在前；可以随时取消，下次接着跑；有更急的任务时让出。设置里关着时不跑。
 */
import { formatEta } from '@emaki/shared';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { readSettings } from '../../datasource/sqlite/settings.ts';
import { loadPoseAsset, readPoseAssetFile } from '../../domain/pose/asset.ts';
import { assignImage } from '../../domain/pose/features.ts';
import { classRefsFromDb, POSE_ELIGIBLE, poseOutdatedCount, posePending, posePendingCount } from '../../domain/pose/read.ts';
import { refreshClassSizes, syncPoseClasses, writePoses, type PoseRow } from '../../domain/pose/store.ts';
import { dropWork, hasWork, markWork } from '../../propagation/work.ts';
import { toAbs } from '../fs/paths.ts';
import { spawnPoseDetector } from './client.ts';
import { poseModelPaths, poseModelsReady, readDetThreshold } from './models.ts';
import type { PoseDetectorFactory, PoseItemResult } from './protocol.ts';

/** 一次发给子进程的张数 */
const BATCH = 8;

export interface PoseStageDeps {
  ctx: SqliteContext;
  modelsDir: string;
  /** null = 真的子进程（infra/ports.ts 的 poseDetector） */
  detector: PoseDetectorFactory | null;
}

/** 模型在不在：换了假检测器（测试）时不需要模型文件 */
export const poseReady = (detector: PoseDetectorFactory | null, modelsDir: string) => !!detector || poseModelsReady(modelsDir);

/** 类别随仓库分发：按版本同步进库（启动、打开功能、每次跑任务前） */
export function ensurePoseClasses(ctx: SqliteContext): void {
  const asset = loadPoseAsset();
  ctx.apply(() => syncPoseClasses(ctx.db, asset, (f) => readPoseAssetFile(f)));
}

/** 用户要求了用新的找人模型重新提取旧版本的姿势、还没重提完 */
export const poseRerunRequested = (ctx: SqliteContext) => hasWork(ctx.db, 'pose-rerun');

/** 记下「重新提取旧版本的」（持久化，重启后接着重提）；没有旧版本的就不记。返回要重提的张数 */
export function requestPoseRerun(ctx: SqliteContext): number {
  const n = poseOutdatedCount(ctx.db);
  if (n) markWork(ctx.db, 'pose-rerun', new Date(ctx.clock()).toISOString());
  return n;
}

export function createPoseStage(deps: PoseStageDeps) {
  const { ctx } = deps;
  const db = ctx.db;
  return {
    enabled: () => readSettings(db).pose.enabled,
    isReady: () => poseReady(deps.detector, deps.modelsDir),
    pendingCount: () => posePendingCount(db, poseRerunRequested(ctx)),
    async run(job: JobContext): Promise<string> {
      if (!readSettings(db).pose.enabled) return '提取姿势：设置里没有打开';
      if (!poseReady(deps.detector, deps.modelsDir)) throw new Error('姿势模型还没准备好（设置 → 姿势检索里下载或复制）');
      ensurePoseClasses(ctx);
      const rerun = poseRerunRequested(ctx);
      // 旧版本的都重提完了（或者本来就没有）：清掉重提的标记
      const rerunDone = () => {
        if (rerun && !poseOutdatedCount(db)) dropWork(db, 'pose-rerun');
      };
      const total = posePendingCount(db, rerun);
      job.setTotal(total);
      if (!total) {
        rerunDone();
        return '提取姿势：没有需要提取的图';
      }
      const refs = classRefsFromDb(db);
      const device = readSettings(db).tagger.device;
      job.setMessage(device === 'dml' ? '提取姿势：加载模型到显卡…' : '提取姿势：加载模型…');
      const paths = poseModelPaths(deps.modelsDir);
      const detector = await (deps.detector ?? spawnPoseDetector)({
        detectorPath: paths.detectorPath,
        detThreshold: readDetThreshold(deps.modelsDir),
        dwposePath: paths.dwposePath,
        device,
      });
      const sel = db.prepare(
        `SELECT i.id, r.path AS root, i.rel_path AS rel FROM images i JOIN library_roots r ON r.id = i.root_id
         LEFT JOIN image_poses p ON p.image_id = i.id
         WHERE ${POSE_ELIGIBLE} AND ${posePending(rerun)} AND i.id < @before ORDER BY i.id DESC LIMIT @limit`,
      );
      let before = Number.MAX_SAFE_INTEGER;
      let done = 0;
      let found = 0;
      const t0 = performance.now();
      const summary = () => `这次提取了 ${done} 张，${found} 张找到了人物`;
      try {
        for (;;) {
          if (job.signal.aborted) return `提取姿势：已取消（${summary()}）`;
          if (job.shouldYield()) {
            job.requeue();
            return `提取姿势：已让出（${summary()}）`;
          }
          const rows = sel.all({ before, limit: BATCH }) as { id: number; root: string; rel: string }[];
          if (!rows.length) break;
          before = rows.at(-1)!.id;
          let results: PoseItemResult[];
          try {
            results = await detector.detect(rows.map((r) => ({ id: r.id, path: toAbs(r.root, r.rel) })));
          } catch (err) {
            if (job.signal.aborted) return `提取姿势：已取消（${summary()}）`;
            throw err;
          }
          const out: PoseRow[] = [];
          for (const r of results) {
            // 文件不在了的留给扫描器，暂时读不了的下次再试；解不开的记一行，不再反复卡在它上面
            if (!r.ok) {
              if (r.code === 'DECODE' || r.code === 'UNSUPPORTED')
                out.push({ imageId: r.id, status: 'decode_error', group: null, person: null, classId: null, nearestId: null, distance: null, mirror: false });
              continue;
            }
            const a = assignImage(r.persons, r.w, r.h, refs);
            if (a.person) found++;
            out.push({
              imageId: r.id,
              status: a.status,
              group: a.group,
              person: a.person ? { person: a.person, w: r.w, h: r.h } : null,
              classId: a.classId,
              nearestId: a.nearestId,
              distance: a.distance,
              mirror: a.mirror,
            });
          }
          const now = new Date(ctx.clock()).toISOString();
          ctx.apply(() => {
            writePoses(db, out, now);
            ctx.changed({ type: 'pose.changed', ids: out.map((o) => o.imageId) });
          });
          done += rows.length;
          const rate = done / ((performance.now() - t0) / 1000);
          const left = (total - done) / rate;
          job.setEta?.(left);
          job.advance(rows.length, `提取姿势：${done} / ${total} · 找到人物 ${found} 张 · ${rate.toFixed(1)} 张/秒 · 剩余约 ${formatEta(left) ?? '—'}`);
        }
      } finally {
        ctx.apply(() => refreshClassSizes(db));
        await detector.dispose();
      }
      rerunDone();
      return `提取姿势：${summary()}（${detector.device === 'dml' ? '显卡' : 'CPU'}）`;
    },
  };
}

export type PoseStage = ReturnType<typeof createPoseStage>;
