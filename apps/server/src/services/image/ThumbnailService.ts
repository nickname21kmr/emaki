/**
 * 缩略图服务：HTTP 按需生成（高优先级）+ 后台任务补齐（低优先级）。
 * 缓存按 sha256 存：<dataDir>/thumbs/v1/ab/<sha256>_<w>.webp，完全重复的图共用一份；文件内容换了 sha 就变了，自然是新的缩略图，
 * 旧 sha 的缓存没人引用后由缓存回收删掉（domain/analysis/cacheGc.ts）。
 * 这里只生成文件；算出来的主色、dHash、生成时间、解码错误、帧数、相机都交给分析模块写（domain/analysis/analyze.ts，P4a），
 * 相机让类型变了时由分析模块声明 image.kindChanged，帧数让是否动图变了时声明 image.animatedChanged（D5：帧数不影响类型）。
 */
import type { ImageFormat, ThumbWidth } from '@emaki/shared';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import PQueue from 'p-queue';
import type { JobContext } from '../../core/jobs.ts';
import type { Db } from '../../db/connection.ts';
import { writeFileAtomic } from '../fs/atomicWrite.ts';
import { toAbs } from '../fs/paths.ts';
import { analyze, markNonJpegCameras, recordCameras, recordDecodeError, recordFrames, recordPixels } from '../../domain/analysis/analyze.ts';
import { collectingTx } from '../../domain/tx.ts';
import type { Change } from '../../propagation/changes.ts';
import { computeDHash } from './dhash.ts';
import { readCameraFromExif, readJpegExifHead } from './exif.ts';
import { computeDominantColor, fitBox, openSharp, processPixels, thumbPath, WEBP } from './pixels.ts';
import { sharp } from './sharpConfig.ts';
import { probeImage } from './probe.ts';
import { FILE_LIVE, ROOT_ACTIVE } from '../../readmodel/terms.ts';

export interface ThumbRow {
  id: number;
  sha256: string;
  format: ImageFormat;
  rel_path: string;
  root_path: string;
  frame_count?: number | null;
}

/** 超过这个大小的原图直接把路径交给 sharp，不整个读进内存 */
const MAX_BUFFERED = 256 * 1024 * 1024;
const BATCH = 200;

const PENDING_WHERE = `(i.thumb_at IS NULL OR (i.frame_count IS NULL AND i.format IN ('webp','png','avif','gif','html')))
  AND i.decode_error IS NULL AND ${FILE_LIVE('i')}`;
/** 还没读过 EXIF 相机的 JPEG（T27）：非 JPEG 直接写 ''，不读文件 */
const CAMERA_WHERE = `i.format = 'jpeg' AND i.camera IS NULL AND ${FILE_LIVE('i')}`;
const ROOT_JOIN = `JOIN library_roots r ON r.id = i.root_id AND ${ROOT_ACTIVE('r')}`;

export class ThumbnailService {
  /** sharp 跑在 libuv 线程池，和 fs 读写共用；并发保持在 2~4，别让 HTTP 读原图排队 */
  readonly queue = new PQueue({ concurrency: Math.max(2, Math.min(4, Math.floor(os.availableParallelism() / 4))) });
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly d: {
      db: Db;
      thumbsRoot: string;
      now?: () => number;
      /**
       * 变更传播（P2）：帧数、相机让类型或是否动图变了时声明 image.kindChanged / image.animatedChanged（合集、Pixiv 资格、查重由反应处理，附录 #3、#17），
       * 缓存和 changed 事件由变更传播按 job:thumbnail 弱刷新、节流推送（RV-T-9）。不给时（单元测试）只开事务
       */
      changes?: { apply<T>(fn: (emit: (c: Change) => void) => T): T };
    },
  ) {}

  private apply<T>(fn: (emit: (c: Change) => void) => T): T {
    return this.d.changes ? this.d.changes.apply(fn) : this.d.db.transaction(() => fn(() => {}))();
  }

  private nowIso(): string {
    return new Date(this.d.now?.() ?? Date.now()).toISOString();
  }

  /** 按需生成：HTTP 用 priority 10，后台任务用 0。返回缓存文件路径；原图解不了时返回 null */
  ensure(row: ThumbRow, width: ThumbWidth, priority = 10): Promise<string | null> {
    const file = thumbPath(this.d.thumbsRoot, row.sha256, width);
    if (existsSync(file)) return Promise.resolve(file);
    // 合并并发请求：网格会对同一张图同时要 240 和 480
    const key = `${row.sha256}_${width}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.queue.add(() => this.generate(row, width), { priority }).then((v) => v ?? null);
      p.finally(() => this.inflight.delete(key)).catch(() => {});
      this.inflight.set(key, p);
    }
    return p;
  }

  private anyCached(sha: string): string | null {
    for (const w of [480, 960, 240]) {
      const f = thumbPath(this.d.thumbsRoot, sha, w);
      if (existsSync(f)) return f;
    }
    return null;
  }

  private async generate(row: ThumbRow, width: ThumbWidth): Promise<string | null> {
    const file = thumbPath(this.d.thumbsRoot, row.sha256, width);
    if (existsSync(file)) return file;

    // 240 且 480 已存在：从 480 缩，便宜
    const f480 = thumbPath(this.d.thumbsRoot, row.sha256, 480);
    if (width === 240 && existsSync(f480)) {
      await writeFileAtomic(file, await sharp(f480).resize(fitBox(240)).webp(WEBP).toBuffer());
      return file;
    }

    const abs = toAbs(row.root_path, row.rel_path);
    let input: Buffer | string;
    try {
      const st = await stat(abs);
      input = st.size > MAX_BUFFERED ? abs : await readFile(abs);
    } catch (err) {
      // 原图没了（移走 / 删了）：退而用其他尺寸的缓存；已处理的重复组还要显示被删的图
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.anyCached(row.sha256);
      throw err;
    }

    // A queued request may refer to the version before an explicit replacement.
    // Never store bytes from the new file under the old SHA cache key.
    if (this.d.db.prepare('SELECT sha256 FROM images WHERE id=?').pluck().get(row.id) !== row.sha256) return null;
    try {
      await this.frameMetadata(row,input);
      if (width === 960) {
        await writeFileAtomic(file, await openSharp(input, row.format).resize(fitBox(960)).webp({ ...WEBP, quality: 82 }).toBuffer());
      } else {
        const px = await processPixels(input, row.format, row.sha256, this.d.thumbsRoot);
        // 多行可能共享同一 sha（完全重复）：分析模块按 sha 写
        recordPixels(this.d.db, row.sha256, { dominantColor: px.dominantColor, dhash: px.dhash, at: this.nowIso() });
      }
      return file;
    } catch (err) {
      recordDecodeError(this.d.db, row.sha256, `解码失败：${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 后台补齐一张：缩略图文件已在缓存里（比如库重建过但缓存还在）时，直接从缓存算主色和 dHash，
   * 否则 thumb_at 永远不会被写上，这行会一直处于待处理状态。
   */
  private async backfillOne(row: ThumbRow): Promise<string | null> {
    const f480 = thumbPath(this.d.thumbsRoot, row.sha256, 480);
    const f240 = thumbPath(this.d.thumbsRoot, row.sha256, 240);
    if (!existsSync(f480)) return this.generate(row, 480);
    if (row.frame_count == null && ['webp','png','avif','gif','html'].includes(row.format)) {
      try { await this.frameMetadata(row,toAbs(row.root_path,row.rel_path)); }
      catch (error) {
        recordDecodeError(this.d.db, row.sha256, `读取动画帧信息失败：${(error as Error).message}`);
        return null;
      }
    }
    // 只有 480 没有 240（写完 480 进程就被打断）：generate(480) 会直接返回，得先从 480 缩出 240
    if (!existsSync(f240)) await this.generate(row, 240);
    const [c, h] = await Promise.all([computeDominantColor(await readFile(f240)), computeDHash(await readFile(f480))]);
    recordPixels(this.d.db, row.sha256, { dominantColor: c, dhash: h, at: this.nowIso() });
    return f480;
  }

  private async frameMetadata(row: ThumbRow, input: Buffer | string): Promise<void> {
    const known = this.d.db.prepare('SELECT frame_count FROM images WHERE id=?').pluck().get(row.id);
    if (known != null) return;
    const probe = await probeImage(input);
    // 看图时（HTTP 生成缩略图）也会走到这里：分析模块写帧数、按帧数判是否动图（D5；帧数不影响类型，类型和判定依据不动），
    // 是否动图真的变了才声明变化，免得每张新图都让前端整页重新拉取
    const ids = this.d.db.prepare('SELECT id FROM images WHERE sha256=?').pluck().all(row.sha256) as number[];
    const tx = collectingTx(this.d.db);
    this.d.db.transaction(() => {
      recordFrames(tx, ids.map((id) => ({ id, frames: probe.pages })));
    })();
    if (tx.changes.length) this.apply((emit) => tx.changes.forEach(emit));
  }

  /** 还没做过像素处理的图数量（Pipeline 用来决定要不要排缩略图任务） */
  pendingCount(): number {
    const db = this.d.db;
    return (
      (db.prepare(`SELECT COUNT(*) FROM images i ${ROOT_JOIN} WHERE ${PENDING_WHERE}`).pluck().get() as number) +
      (db.prepare(`SELECT COUNT(*) FROM images i ${ROOT_JOIN} WHERE ${CAMERA_WHERE}`).pluck().get() as number)
    );
  }

  /**
   * 已入库 JPEG 的 EXIF 相机回填（T27 第 3 条）：每批 200 张，只读前 128KB，批间让出，可以取消。
   * 读到相机后，对没手动改过类型的行当场重算类型。只读文件，不改大小和修改时间，扫描器不会因此触发。
   */
  private async backfillCameras(ctx: JobContext): Promise<number> {
    const db = this.d.db;
    markNonJpegCameras(db);
    const batchStmt = db.prepare(`SELECT i.id, i.rel_path, r.path AS root_path FROM images i ${ROOT_JOIN}
      WHERE ${CAMERA_WHERE} AND i.id > @last ORDER BY i.id LIMIT ${BATCH}`);
    let last = 0;
    let found = 0;
    for (;;) {
      if (ctx.signal.aborted || ctx.shouldYield()) break;
      const rows = batchStmt.all({ last }) as { id: number; rel_path: string; root_path: string }[];
      if (!rows.length) break;
      last = rows.at(-1)!.id;
      const cams: [number, string][] = [];
      for (const r of rows) {
        let cam = '';
        try {
          cam = readCameraFromExif(await readJpegExifHead(toAbs(r.root_path, r.rel_path)));
        } catch {
          /* 读不了就当不是相机；文件问题交给扫描器 */
        }
        cams.push([r.id, cam]);
      }
      const hits = cams.filter(([, c]) => c).map(([id]) => id);
      // 分析模块写相机；读到相机的当场重判类型（类型变了由它声明 image.kindChanged）
      this.apply((emit) => {
        recordCameras(db, cams.map(([id, camera]) => ({ id, camera })));
        analyze({ db, changed: emit }, hits);
      });
      found += hits.length;
      ctx.advance(rows.length);
      await new Promise((r) => setImmediate(r));
    }
    return found;
  }

  /** 后台任务 thumbnail：新图先处理，可以让出给扫描 */
  async runBackfill(ctx: JobContext): Promise<string> {
    const total = this.pendingCount();
    ctx.setTotal(total);
    const batchStmt = this.d.db.prepare(`SELECT i.id, i.sha256, i.format, i.rel_path, i.frame_count, r.path AS root_path
      FROM images i ${ROOT_JOIN}
      WHERE ${PENDING_WHERE} AND i.id < @last
      ORDER BY i.id DESC LIMIT ${BATCH}`);
    const seen = new Set<string>();
    let last = Number.MAX_SAFE_INTEGER;
    let ok = 0;
    let failed = 0;
    let doneCount = 0;

    for (;;) {
      if (ctx.signal.aborted) break;
      if (ctx.shouldYield()) {
        await this.queue.onIdle();
        ctx.requeue();
        return `已让出给扫描：完成 ${ok} 张`;
      }
      const rows = batchStmt.all({ last }) as ThumbRow[];
      if (!rows.length) break;
      last = rows[rows.length - 1]!.id;
      for (const row of rows) {
        if (ctx.signal.aborted) break;
        if (seen.has(row.sha256)) {
          doneCount++;
          ctx.advance(1);
          continue;
        }
        seen.add(row.sha256);
        await this.queue.onSizeLessThan(2); // 反压：别一次塞 10 万个任务
        void this.queue
          .add(() => this.backfillOne(row), { priority: 0 })
          .then((f) => (f ? ok++ : failed++))
          .catch(() => failed++)
          .finally(() => {
            doneCount++;
            ctx.advance(1, `${doneCount}/${total}`);
          });
      }
    }
    await this.queue.onIdle();
    // 缩略图、主色写完了：让列表和统计刷新（弱刷新）
    this.apply(() => {});
    const cams = await this.backfillCameras(ctx);
    return `生成缩略图：完成 ${ok} 张，失败 ${failed} 张${cams ? `；认出 ${cams} 张相机照片` : ''}`;
  }
}
