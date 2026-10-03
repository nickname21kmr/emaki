/**
 * 「识别角色」后台任务：候选图 → 推理子进程 → TagResultWriter 写库。
 * 保持 3 批在途（下一批预处理和本批推理重叠）；可取消、可让出给扫描；DML 子进程崩溃自动转 CPU 重试一次。
 */
import type { ContentKind, Rating, Settings } from '@emaki/shared';
import type { EventBus } from '../../core/events.ts';
import type { JobRunner } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { CharacterCatalog } from '../catalog/characterCatalog.ts';
import { CopyrightResolver, type CopyrightSource } from '../catalog/copyrights.ts';
import { toAbs } from '../fs/paths.ts';
import { backfillClassification } from '../classify/backfill.ts';
import { readCameraFromExif, readJpegExifHead } from '../image/exif.ts';
import type { TagStage } from '../pipeline.ts';
import { acquireTagger, releaseTagger, shutdownTagger, TaggerCrashedError, type TaggerLike, type TaggerStartOptions } from './client.ts';
import { ARTIST_THRESHOLD } from './artists.ts';
import { ensureModelFiles, isModelReady } from './download.ts';
import { clampBatch, findModel, TAGGER_MODELS, type TaggerModelSpec } from './models.ts';
import type { HostItemResult, HostThresholds } from './protocol.ts';
import { TagResultWriter } from './writer.ts';

export interface TagJobDeps {
  db: Db;
  bus: EventBus;
  modelsDir: string;
  /** readSettings(db).tagger（同步） */
  getTaggerSettings(): Settings['tagger'];
  /** 每次任务 new 一个 catalog；T11 / T12 注入升级版 */
  makeCatalog?: () => { catalog: CharacterCatalog; copyrights: CopyrightSource };
  /** T17：同一事务里对本批图应用排除规则 */
  afterBatchInTx?: (imageIds: number[]) => void;
  log?: (msg: string) => void;
  now?: () => number;
  // 测试注入
  clientFactory?: (o: TaggerStartOptions) => Promise<TaggerLike>;
  ensureFiles?: typeof ensureModelFiles;
}

/**
 * 候选图。分两轮（legacyBefore 为 null 时只有主模型一轮，和以前一样）：
 * - 旧模型轮：没识别过、文件时间早于 @before
 * - 主模型轮：没识别过、文件时间不早于 @before；以及别的模型识别过、没认出角色、文件时间不早于 @before 的（@retryOld = 1 时不看时间）；
 *   以及用户在「未识别」里要求重新识别的（retag = 1，不管之前是哪个模型认的）
 * 两轮都跳过相机照片（@skipCamera = 1）。@before 为 NULL 时主模型轮覆盖全部。
 */
const BASE = `r.enabled = 1 AND r.removed_at IS NULL AND i.missing = 0 AND i.trashed_at IS NULL AND i.excluded_by IS NULL
  AND NOT (@skipCamera = 1 AND i.content_kind = 'photo' AND COALESCE(i.camera, '') <> '')`;
const NEWER = '(@before IS NULL OR i.modified_at >= @before)';
const WHERE_PRIMARY = `${BASE} AND (
  (i.tagged_at IS NULL AND ${NEWER})
  OR i.retag = 1
  OR (i.tagged_at IS NOT NULL AND i.tagger_model IS NOT @model AND (${NEWER} OR @retryOld = 1)
      AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id)))`;
const WHERE_LEGACY = `${BASE} AND i.tagged_at IS NULL AND i.modified_at < @before`;
const count = (where: string) => `SELECT COUNT(*) AS n FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${where}`;
const batch = (where: string) => `SELECT i.id AS id, r.path AS rootPath, i.rel_path AS relPath, i.format AS format, i.camera AS camera
  FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE ${where} AND i.id < @beforeId ORDER BY i.id DESC LIMIT @limit`;

/** 这次要跑的几轮：先旧模型（快），再主模型 */
interface Pass {
  spec: TaggerModelSpec;
  where: string;
}
function planPasses(t: Settings['tagger']): Pass[] {
  const primary = findModel(t.model);
  if (!primary) throw new Error(`不支持的模型：${t.model}。可选：${TAGGER_MODELS.map((m) => m.repo).join('、')}`);
  const legacy = t.legacyBefore && t.legacyModel && t.legacyModel !== t.model ? findModel(t.legacyModel) : null;
  return [...(legacy ? [{ spec: legacy, where: WHERE_LEGACY }] : []), { spec: primary, where: WHERE_PRIMARY }];
}
const passParams = (t: Settings['tagger'], p: Pass) => ({
  model: p.spec.repo,
  before: t.legacyBefore && t.legacyModel && t.legacyModel !== t.model && findModel(t.legacyModel) ? t.legacyBefore : null,
  skipCamera: t.skipCameraPhotos === false ? 0 : 1,
  retryOld: t.retryOld ? 1 : 0,
});

interface Row {
  id: number;
  rootPath: string;
  relPath: string;
  format: string;
  camera: string | null;
}

const IN_FLIGHT = 3;
const EMIT_MS = 5000;
/** 识别胶卷的 job-item 最短间隔（每秒最多 4 条） */
const ITEM_MS = 250;

const mb = (n: number) => (n / 1048576).toFixed(0);

function formatEta(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} 分钟`;
  return `${(sec / 3600).toFixed(1)} 小时`;
}

/**
 * 显卡卡死 / 被系统重置（子进程没崩，但这次推理报错，显卡上的会话也废了）：
 * DXGI_ERROR_DEVICE_REMOVED / HUNG / RESET（0x887A0005–7），DML 读回失败，WebGPU 设备丢失
 */
const GPU_LOST = /887A000[5-7]|readback failed|device (?:hung|removed|lost|reset)/i;
const isGpuLost = (err: unknown) => err instanceof Error && GPU_LOST.test(err.message);

/** 显卡子进程崩溃或显卡卡死时换成 CPU 客户端重试一次；多个在途请求同时失败时靠「代数」只切换一次 */
class ResilientTagger {
  private generation = 0;
  private shrunk = false;
  private toWebgpu = false;
  private fellBack = false;

  constructor(
    private client: TaggerLike,
    private readonly opts: TaggerStartOptions,
    private readonly factory: (o: TaggerStartOptions) => Promise<TaggerLike>,
    private readonly onSwitch: (c: TaggerLike) => void,
  ) {}

  get current(): TaggerLike {
    return this.client;
  }

  private switching: Promise<void> | null = null;

  async tag(items: { id: number; path: string }[], th: HostThresholds): Promise<HostItemResult[]> {
    const gen = this.generation;
    try {
      return await this.client.tag(items, th);
    } catch (err) {
      const lost = isGpuLost(err);
      if (!(err instanceof TaggerCrashedError || lost)) throw err;
      if (gen === this.generation) {
        // 这个请求发出后没切换过、而且当时用的就是 CPU：CPU 也崩了，没救
        if (this.client.device === 'cpu' || this.fellBack) throw err;
        // 显卡卡死多半是一批算得太久、超过了 Windows 的 2 秒看门狗：先在显卡上改成一张一批；
        // 还不行、而且模型能走 WebGPU（PixAI）就换 WebGPU；最后才换 CPU
        const shrink = lost && !this.shrunk && this.client.batchSize > 1;
        const webgpu = !shrink && !this.toWebgpu && this.client.device === 'dml' && !!findModel(this.opts.repo)?.webgpuFallback;
        let next: TaggerStartOptions;
        if (shrink) {
          this.shrunk = true;
          next = { ...this.opts, batchSize: 1 };
        } else if (webgpu) {
          this.toWebgpu = true;
          next = { ...this.opts, noDml: true };
        } else {
          this.fellBack = true;
          next = { ...this.opts, device: 'cpu', batchSize: Math.min(this.opts.batchSize, 4) };
        }
        this.switching = this.factory(next).then((c) => {
          this.client = c;
          this.generation++;
          this.onSwitch(c);
        });
      }
      await this.switching;
      return this.tag(items, th);
    }
  }
}

export function createTagJobRunner(deps: TagJobDeps): JobRunner {
  const { db } = deps;
  const log = deps.log ?? (() => {});
  const factory = deps.clientFactory ?? acquireTagger;
  const ensure = deps.ensureFiles ?? ensureModelFiles;

  return async (ctx) => {
    const t = deps.getTaggerSettings();
    const passes = planPasses(t);
    const counts = passes.map((p) => (db.prepare(count(p.where)).get(passParams(t, p)) as { n: number }).n);
    const grand = counts.reduce((a, b) => a + b, 0);
    const nowIso = () => new Date(deps.now?.() ?? Date.now()).toISOString();
    let doneAll = 0;
    const summaries: string[] = [];
    let yieldedAny = false;
    ctx.setTotal(grand);
    for (let k = 0; k < passes.length; k++) {
      if (ctx.signal.aborted) break;
      if (counts[k] === 0 && k < passes.length - 1) continue;
      const r = await runPass(passes[k]!, counts[k]!);
      if (r.message) summaries.push(r.message);
      if (r.yielded) {
        yieldedAny = true;
        break;
      }
    }
    if (yieldedAny && !ctx.signal.aborted) {
      ctx.requeue();
      return `识别角色：已让出给扫描（本次处理 ${doneAll} 张）`;
    }
    return summaries.join('；') || '没有需要识别的图片';

    async function runPass(pass: Pass, total: number): Promise<{ message: string | null; yielded: boolean }> {
    const spec = pass.spec;
    const params = passParams(t, pass);
    const selBatch = db.prepare(batch(pass.where));
    const itemImage = db.prepare('SELECT dominant_color, rating, content_kind FROM images WHERE id = ?');
    const itemChars = db.prepare(
      'SELECT c.name, ic.score FROM image_characters ic JOIN characters c ON c.id = ic.character_id WHERE ic.image_id = ? ORDER BY ic.score DESC',
    );

    const { catalog, copyrights } = deps.makeCatalog?.() ?? {
      catalog: new CharacterCatalog(db, { copyrights: CopyrightResolver.fromAsset(db) }),
      copyrights: CopyrightResolver.fromAsset(db),
    };
    const writer = new TagResultWriter(db, catalog, copyrights, {
      repo: spec.repo,
      generalThreshold: t.generalThreshold,
      characterThreshold: t.characterThreshold,
      autoAcceptThreshold: t.autoAcceptThreshold,
      afterBatchInTx: deps.afterBatchInTx,
      now: deps.now,
    });

    // 阶段 0：阈值调低后已达标的建议直接采纳；没有作品的角色补挂作品
    const promoted = writer.promoteSuggestions();
    db.transaction(() => catalog.backfillWorks(nowIso()))();

    if (total === 0) return { message: promoted ? `已按新阈值采纳 ${promoted} 条建议` : null, yielded: false };

    ctx.setMessage('识别角色：检查模型文件…');
    const files = await ensure(spec, deps.modelsDir, {
      signal: ctx.signal,
      onProgress: (p) => ctx.setMessage(`下载模型 ${p.file}（${p.source}）${mb(p.received)}/${mb(p.total)} MB`),
    });
    if (ctx.signal.aborted) return { message: '识别角色：已取消', yielded: false };

    const tag = passes.length > 1 ? `${spec.label.replace(/（.*$/, '')} · ` : '';
    ctx.setMessage(t.device === 'dml' ? `识别角色：${tag}加载模型到显卡（首次约 30–90 秒）…` : `识别角色：${tag}加载模型…`);
    const opts: TaggerStartOptions = {
      repo: spec.repo,
      modelPath: files.modelPath,
      labelsPath: files.labelsPath,
      device: t.device,
      batchSize: clampBatch(spec, t.device, t.batchSize),
      modelsDir: deps.modelsDir,
    };
    let deviceLabel = '';
    let fallbackNote = '';
    const describe = (c: TaggerLike) => {
      deviceLabel = c.device === 'dml' ? `GPU·DirectML#${c.info.dmlDeviceId}` : c.device === 'webgpu' ? 'GPU·WebGPU' : 'CPU';
      if (c.device === 'webgpu' && spec.gpu === 'dml') fallbackNote = 'DirectML 不可用，已改用 WebGPU（慢一些）';
      else if (c.info.fallbackReason || (c.device === 'cpu' && t.device === 'dml')) {
        fallbackNote = spec.webgpuFallback || spec.gpu === 'webgpu' ? '显卡用不了，已改用 CPU（很慢）' : 'DirectML 不可用，已改用 CPU（较慢，可在设置里换 SwinV2 模型）';
      }
      log(`tagger 子进程 pid=${c.info.pid} device=${c.device}${c.info.fallbackReason ? `（${c.info.fallbackReason}）` : ''}`);
    };
    const first = await factory(opts);
    describe(first);
    const tagger = new ResilientTagger(first, opts, factory, describe);

    try {
      if (fallbackNote) ctx.setMessage(fallbackNote);
      const th: HostThresholds = {
        general: t.generalThreshold,
        character: Math.min(t.characterThreshold, t.autoAcceptThreshold),
        ...(t.artists ? { artist: ARTIST_THRESHOLD } : {}),
      };
      const B = tagger.current.batchSize;
      let beforeId = Number.MAX_SAFE_INTEGER;
      let yielded = false;
      let done = 0;
      let skipped = 0;
      const t0 = performance.now();
      let lastEmit = t0;
      let lastItem = 0;

      // 识别胶卷（SEL-19）：这一批里挑一张（优先认出了角色的），限流每秒最多 4 条
      const emitItem = (results: HostItemResult[]) => {
        if (!ctx.jobId || performance.now() - lastItem < ITEM_MS) return;
        const ok = results.filter((r) => r.ok);
        const pick = [...ok].reverse().find((r) => r.character.length) ?? ok[ok.length - 1];
        if (!pick) return;
        const img = itemImage.get(pick.id) as { dominant_color: string | null; rating: Rating; content_kind: ContentKind } | undefined;
        if (!img) return;
        const chars = itemChars.all(pick.id) as { name: string; score: number | null }[];
        lastItem = performance.now();
        deps.bus.emit({
          type: 'job-item',
          jobId: ctx.jobId,
          imageId: String(pick.id),
          dominantColor: img.dominant_color,
          rating: img.rating,
          kind: img.content_kind,
          characterNames: chars.slice(0, 2).map((c) => c.name),
          score: chars[0]?.score ?? null,
        });
      };

      // 缩略图任务最后才读相机信息；和它并行时，这里先把本批 JPEG 的相机读出来，相机照片当场跳过（不送进模型）
      const setCamera = db.prepare('UPDATE images SET camera = ? WHERE id = ?');
      const next = async (): Promise<Row[]> => {
        for (;;) {
          const rows = selBatch.all({ ...params, beforeId, limit: B }) as Row[];
          if (!rows.length) return rows;
          beforeId = rows[rows.length - 1]!.id;
          const unknown = rows.filter((r) => r.format === 'jpeg' && r.camera === null);
          if (!unknown.length) return rows;
          const cams = await Promise.all(
            unknown.map(async (r) => [r, await readJpegExifHead(toAbs(r.rootPath, r.relPath)).then(readCameraFromExif, () => '')] as const),
          );
          const hits = cams.filter(([, c]) => c).map(([r]) => r.id);
          db.transaction(() => {
            for (const [r, c] of cams) setCamera.run(c, r.id);
            if (hits.length) backfillClassification(db, { ids: hits });
          })();
          if (!hits.length || !params.skipCamera) return rows;
          ctx.advance(hits.length);
          skipped += hits.length;
          const keep = rows.filter((r) => !hits.includes(r.id));
          if (keep.length) return keep;
        }
      };
      const queue: { rows: Row[]; p: Promise<HostItemResult[]> }[] = [];
      const fill = async () => {
        while (queue.length < IN_FLIGHT && !ctx.signal.aborted) {
          if (ctx.shouldYield()) {
            yielded = true; // 同一条道里有更急的任务：不再发新批
            break;
          }
          const rows = await next();
          if (!rows.length) break;
          const p = tagger.tag(rows.map((r) => ({ id: r.id, path: toAbs(r.rootPath, r.relPath) })), th);
          p.catch(() => undefined); // 必须加：排队中的 promise 被 reject 会触发 unhandledRejection，把服务进程带崩
          queue.push({ rows, p });
        }
      };

      await fill();
      while (queue.length) {
        const { rows, p } = queue.shift()!;
        const results = await p; // 出错原样抛出，任务 failed
        await fill(); // 先把下一批发出去，再写库
        writer.writeBatch(results);
        emitItem(results);
        done += rows.length;
        doneAll += rows.length;
        const rate = done / ((performance.now() - t0) / 1000);
        // 剩余时间只按这一轮的速度估（旧模型快、新模型慢）；后面还有轮次时注明
        const later = counts.slice(passes.indexOf(pass) + 1).reduce((a, b) => a + b, 0);
        ctx.advance(
          rows.length,
          `${tag}${done} / ${total} · ${deviceLabel} · ${rate.toFixed(1)} 张/秒 · 这一轮剩余约 ${formatEta((total - done) / rate)}${later ? ` · 之后还有 ${later} 张用新模型` : ''}`,
        );
        if (performance.now() - lastEmit > EMIT_MS) {
          deps.bus.emit({ type: 'library-changed', reason: 'tag' });
          lastEmit = performance.now();
        }
      }
      if (yielded && !ctx.signal.aborted) return { message: null, yielded: true };
      const s = writer.stats;
      return {
        message: `${tag}识别角色：完成 ${done} 张 · 新建角色 ${s.createdCharacters} · 建议 ${s.suggestions} · 失败 ${s.failed}${skipped ? ` · 跳过相机照片 ${skipped} 张` : ''}`,
        yielded: false,
      };
    } finally {
      // 换模型的轮次之间立刻释放（两个大模型同时占显存会爆）；最后一轮照旧空闲 60 秒后关
      if (!deps.clientFactory) {
        if (passes.indexOf(pass) < passes.length - 1) await shutdownTagger();
        else releaseTagger();
      }
      log(`统计 ${JSON.stringify(writer.stats)}`);
    }
    }
  };
}

/** 给 T07 Pipeline 的阶段对象 */
export function createTagStage(deps: TagJobDeps): TagStage {
  return {
    isReady: () => {
      const s = findModel(deps.getTaggerSettings().model);
      return !!s && isModelReady(s, deps.modelsDir);
    },
    pendingCount: () => {
      const t = deps.getTaggerSettings();
      return planPasses(t).reduce((n, p) => n + (deps.db.prepare(count(p.where)).get(passParams(t, p)) as { n: number }).n, 0);
    },
    run: createTagJobRunner(deps),
  };
}
