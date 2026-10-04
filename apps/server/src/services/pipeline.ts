/**
 * 后台任务链：把 JobKind 映射到各个 service，并负责链式触发
 *   scan → thumbnail → tag（模型就绪时）→ dedupe；tag 之后按需 danbooru-sync。
 * 各阶段由对应任务注入（register）；没有注入的阶段 runner 抛 NotImplementedError，任务显示 failed 并提示缺哪一项。
 */
import type { JobKind } from '@emaki/shared';
import type { JobContext, JobQueue, JobRunner } from '../core/jobs.ts';
import { NotImplementedError } from '../http/errors.ts';
import type { ThumbnailService } from './image/ThumbnailService.ts';
import { formatScanSummary, type Scanner, type ScanSummary } from './scan/Scanner.ts';
import type { ScanRequests } from './scan/ScanRequests.ts';

/** T10 */
export interface TagStage {
  isReady(): boolean;
  pendingCount(): number;
  run: JobRunner;
}
/** T11 */
export interface DanbooruStage {
  shouldRunAfterTag(): boolean;
  run: JobRunner;
}
/** 画师（默认关，设置里打开） */
export interface ArtistStage {
  enabled(): boolean;
  pendingCount(): number;
  run: JobRunner;
}
/** T16 */
export interface DedupeStage {
  run(ctx: JobContext): Promise<string>;
}

export interface PipelineDeps {
  /** 延迟获取，避免构造时循环依赖 */
  jobs: () => JobQueue;
  requests: ScanRequests;
  scanner: Scanner;
  thumbs: ThumbnailService;
  pixelPendingCount: () => number;
  tag?: TagStage;
  danbooru?: DanbooruStage;
  dedupe?: DedupeStage;
  artists?: ArtistStage;
  /** T20：refreshTagCounts */
  afterTag?: () => void;
  /** 扫描完成（没被取消）后的钩子，例如 T08 重新同步监听 */
  afterScan?: (s: ScanSummary) => void;
}

/** 延后的文件（2 秒内刚写入）过多久再扫 */
const DEFERRED_RETRY_MS = 3000;

export type PipelineStages = Partial<Pick<PipelineDeps, 'tag' | 'danbooru' | 'dedupe' | 'artists' | 'afterTag' | 'afterScan'>>;

export class Pipeline {
  private dedupeDirty = false;
  /** 用户取消了识别：之后不再自动续跑，直到用户手动开始（进程内状态，重启后恢复自动） */
  private tagPaused = false;
  /** 用户取消了画师补跑：之后不自动续跑，直到手动点「补跑」或重新打开开关 */
  private artistsPaused = false;

  constructor(private d: PipelineDeps) {}

  /** 让后续任务在 open() 之后注册自己的阶段 */
  register(stages: PipelineStages): void {
    this.d = { ...this.d, ...stages };
  }

  runner =
    (kind: JobKind): JobRunner =>
    async (ctx) => {
      switch (kind) {
        case 'scan': {
          const s = await this.d.scanner.scan(ctx);
          // 取消的扫描不触发后续任务（这时也没做丢失判定）
          if (!ctx.signal.aborted) {
            this.afterScan(s);
            this.d.afterScan?.(s);
          }
          return formatScanSummary(s);
        }
        case 'thumbnail': {
          const msg = await this.d.thumbs.runBackfill(ctx);
          if (!ctx.signal.aborted && !ctx.yielded) this.afterThumbnail();
          return msg;
        }
        case 'tag': {
          if (!this.d.tag) throw new NotImplementedError('T10', '角色识别');
          const msg = await this.d.tag.run(ctx);
          if (ctx.signal.aborted) this.tagPaused = true;
          if (!ctx.signal.aborted && !ctx.yielded) {
            this.d.afterTag?.();
            if (this.d.danbooru?.shouldRunAfterTag()) this.d.jobs().enqueue('danbooru-sync');
            if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
            // 开着画师的：接着补（新图、WD 识别的旧图、重启前没补完的）；用户取消过就等他手动再点
            const a = this.d.artists;
            if (a?.enabled() && !this.artistsPaused && a.pendingCount() > 0) this.d.jobs().enqueue('artists');
          }
          return msg;
        }
        case 'artists': {
          if (!this.d.artists) throw new NotImplementedError('artists', '识别画师');
          if (!this.d.artists.enabled()) return '识别画师：设置里没有打开';
          const msg = await this.d.artists.run(ctx);
          if (ctx.signal.aborted) this.artistsPaused = true;
          // 认出新画师后，同步 Danbooru 拿日文名、推特（打开了联网同步时）
          if (!ctx.signal.aborted && !ctx.yielded && this.d.danbooru?.shouldRunAfterTag()) this.d.jobs().enqueue('danbooru-sync');
          return msg;
        }
        case 'dedupe': {
          if (!this.d.dedupe) throw new NotImplementedError('T16', '查重');
          const msg = await this.d.dedupe.run(ctx);
          if (!ctx.signal.aborted) this.dedupeDirty = false;
          return msg;
        }
        case 'danbooru-sync': {
          if (!this.d.danbooru) throw new NotImplementedError('T11', 'Danbooru 同步');
          return this.d.danbooru.run(ctx);
        }
      }
    };

  private afterScan(s: ScanSummary) {
    // 有「刚写入、延后处理」的文件：它们的目录已在 requests 里，过一会儿再扫一次，
    // 否则要等下一个文件事件才会入库（浏览器刚下载完的图就是这种情况）
    if (s.deferred > 0) {
      const t = setTimeout(() => this.d.jobs().enqueue('scan', { requeueIfRunning: true }), DEFERRED_RETRY_MS);
      t.unref();
    }
    const changed = s.added + s.updated + s.moved + s.restored > 0;
    if (changed) this.dedupeDirty = true;
    if (changed || this.d.pixelPendingCount() > 0) {
      // 识别在另一条道里和缩略图并行，扫描完就排上（它自己读原图，不依赖缩略图）
      this.maybeTag();
      this.d.jobs().enqueue('thumbnail');
    }
    // 没有新图也要接着往下走：进程重启（开发模式改代码、崩溃、关掉再开）会丢掉跑到一半的识别，
    // 启动时的扫描没有新图，不接着走的话剩下的图永远不会被识别
    else this.afterThumbnail();
  }

  /** 启动时发现从没查过重、或查重之后又有新图：下次任务链走到时补跑查重 */
  markDedupeDirty(): void {
    this.dedupeDirty = true;
  }

  /** 用户手动开始某个任务（取消识别后再点「运行识别」→ 恢复自动续跑） */
  noteManualStart(kind: JobKind): void {
    if (kind === 'tag') this.tagPaused = false;
    if (kind === 'artists') this.artistsPaused = false;
  }

  private afterThumbnail() {
    // 模型还没下载时 isReady() 为 false：不会自动触发 1.26 GB 的下载，用户点「运行识别」才开始
    // 查重只依赖缩略图阶段算好的 dHash，先跑（几秒），不用等识别跑完（CR-14）
    if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
    this.maybeTag();
  }

  private maybeTag() {
    const t = this.d.tag;
    if (t?.isReady() && !this.tagPaused && t.pendingCount() > 0) this.d.jobs().enqueue('tag');
    // 没有要识别的（比如重启后）：画师补跑没完就接着补。有识别时等识别完再接（同在显卡道里，优先级也低）
    else {
      const a = this.d.artists;
      if (a?.enabled() && !this.artistsPaused && a.pendingCount() > 0) this.d.jobs().enqueue('artists');
    }
  }
}
