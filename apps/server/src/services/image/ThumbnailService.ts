/**
 * 缩略图服务：HTTP 按需生成（高优先级）+ 后台任务补齐（低优先级）。
 * 缓存按 sha256 存：<dataDir>/thumbs/v1/ab/<sha256>_<w>.webp，完全重复的图共用一份。
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
import { backfillClassification } from '../classify/backfill.ts';
import { computeDHash } from './dhash.ts';
import { readCameraFromExif, readJpegExifHead } from './exif.ts';
import { computeDominantColor, fitBox, openSharp, processPixels, thumbPath, WEBP } from './pixels.ts';
import { sharp } from './sharpConfig.ts';

export interface ThumbRow {
  id: number;
  sha256: string;
  format: ImageFormat;
  rel_path: string;
  root_path: string;
}

/** 超过这个大小的原图直接把路径交给 sharp，不整个读进内存 */
const MAX_BUFFERED = 256 * 1024 * 1024;
const BATCH = 200;

const PENDING_WHERE = `i.thumb_at IS NULL AND i.decode_error IS NULL AND i.missing = 0 AND i.trashed_at IS NULL`;
/** 还没读过 EXIF 相机的 JPEG（T27）：非 JPEG 直接写 ''，不读文件 */
const CAMERA_WHERE = `i.format = 'jpeg' AND i.camera IS NULL AND i.missing = 0 AND i.trashed_at IS NULL`;
const ROOT_JOIN = `JOIN library_roots r ON r.id = i.root_id AND r.enabled = 1 AND r.removed_at IS NULL`;

export class ThumbnailService {
  /** sharp 跑在 libuv 线程池，和 fs 读写共用；并发保持在 2~4，别让 HTTP 读原图排队 */
  readonly queue = new PQueue({ concurrency: Math.max(2, Math.min(4, Math.floor(os.availableParallelism() / 4))) });
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly d: {
      db: Db;
      thumbsRoot: string;
      now?: () => number;
      /** EXIF 回填每写完一批调用（发 library-changed，RV-T-9） */
      onCamerasUpdated?: () => void;
    },
  ) {}

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

    try {
      if (width === 960) {
        await writeFileAtomic(file, await openSharp(input, row.format).resize(fitBox(960)).webp({ ...WEBP, quality: 82 }).toBuffer());
      } else {
        const px = await processPixels(input, row.format, row.sha256, this.d.thumbsRoot);
        // 多行可能共享同一 sha（完全重复）：按 sha 更新
        this.d.db
          .prepare('UPDATE images SET dominant_color=@c, dhash=@h, thumb_at=@now, decode_error=NULL WHERE sha256=@sha')
          .run({ c: px.dominantColor, h: px.dhash, now: new Date(this.d.now?.() ?? Date.now()).toISOString(), sha: row.sha256 });
      }
      return file;
    } catch (err) {
      this.d.db
        .prepare('UPDATE images SET decode_error=@err WHERE sha256=@sha')
        .run({ err: `解码失败：${(err as Error).message}`, sha: row.sha256 });
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
    if (!existsSync(f480) || !existsSync(f240)) return this.generate(row, 480);
    const [c, h] = await Promise.all([computeDominantColor(await readFile(f240)), computeDHash(await readFile(f480))]);
    this.d.db
      .prepare('UPDATE images SET dominant_color=@c, dhash=@h, thumb_at=@now, decode_error=NULL WHERE sha256=@sha')
      .run({ c, h, now: new Date(this.d.now?.() ?? Date.now()).toISOString(), sha: row.sha256 });
    return f480;
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
    db.prepare("UPDATE images SET camera = '' WHERE camera IS NULL AND format <> 'jpeg'").run();
    const batchStmt = db.prepare(`SELECT i.id, i.rel_path, r.path AS root_path FROM images i ${ROOT_JOIN}
      WHERE ${CAMERA_WHERE} AND i.id > @last ORDER BY i.id LIMIT ${BATCH}`);
    const upd = db.prepare('UPDATE images SET camera = ? WHERE id = ?');
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
      db.transaction(() => {
        for (const [id, cam] of cams) upd.run(cam, id);
        if (hits.length) backfillClassification(db, { ids: hits });
      })();
      found += hits.length;
      ctx.advance(rows.length);
      this.d.onCamerasUpdated?.();
      await new Promise((r) => setImmediate(r));
    }
    return found;
  }

  /** 后台任务 thumbnail：新图先处理，可以让出给扫描 */
  async runBackfill(ctx: JobContext): Promise<string> {
    const total = this.pendingCount();
    ctx.setTotal(total);
    const batchStmt = this.d.db.prepare(`SELECT i.id, i.sha256, i.format, i.rel_path, r.path AS root_path
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
    const cams = await this.backfillCameras(ctx);
    return `生成缩略图：完成 ${ok} 张，失败 ${failed} 张${cams ? `；认出 ${cams} 张相机照片` : ''}`;
  }
}
