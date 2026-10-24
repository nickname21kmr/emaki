/**
 * 后台任务链：把 JobKind 映射到各个 service，并负责链式触发
 *   scan → thumbnail → tag（模型就绪时）→ dedupe；tag 之后按需 danbooru-sync，设置里打开了再补 pixiv-tags。
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
  /** manual：用户点了「运行识别」。自动续跑时不去下载还没下载的旧图模型 */
  run(ctx: JobContext, o?: { manual?: boolean }): Promise<void | string>;
}
/** T11 */
export interface DanbooruStage {
  shouldRunAfterTag(): boolean;
  run: JobRunner;
}
/** 画师（默认关，设置里打开） */
export interface ArtistStage {
  enabled(): boolean;
  /** 模型文件在不在：不在时不自动续补 */
  isReady(): boolean;
  pendingCount(): number;
  run: JobRunner;
}
/** T16 */
export interface DedupeStage {
  run(ctx: JobContext): Promise<string>;
}
/** 按 Pixiv 标签补充角色（会联网）：enabled() 只管识别后的自动排队，手动点按钮照常跑 */
export interface PixivStage {
  enabled(): boolean;
  pendingCount(): number;
  run: JobRunner;
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
  pixiv?: PixivStage;
  /** T20：refreshTagCounts */
  afterTag?: () => void;
  /** 扫描完成（没被取消）后的钩子，例如 T08 重新同步监听 */
  afterScan?: (s: ScanSummary) => void;
}

/** 延后的文件（2 秒内刚写入）过多久再扫 */
const DEFERRED_RETRY_MS = 3000;

export type PipelineStages = Partial<Pick<PipelineDeps, 'tag' | 'danbooru' | 'dedupe' | 'artists' | 'pixiv' | 'afterTag' | 'afterScan'>>;

export class Pipeline {
  private dedupeDirty = false;
  /** 用户取消了识别：之后不再自动续跑，直到用户手动开始（进程内状态，重启后恢复自动） */
  private tagPaused = false;
  /** 用户取消了画师补跑：之后不自动续跑，直到手动点「补跑」或重新打开开关 */
  private artistsPaused = false;
  /** 用户点了「运行识别」：下一次识别可以下载旧图模型（自动排上的不下） */
  private tagManual = false;
  private pixivPaused = false;
  private pixivFailed = false;
  /** 这一轮 Pixiv 补充是用户点按钮开始的（让出后续跑的也算）：关掉设置时不取消它 */
  private pixivManual = false;

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
          const manual = this.tagManual;
          this.tagManual = false;
          const msg = await this.d.tag.run(ctx, { manual });
          if (ctx.signal.aborted) this.tagPaused = true;
          if (!ctx.signal.aborted && !ctx.yielded) {
            this.d.afterTag?.();
            if (this.d.danbooru?.shouldRunAfterTag()) this.d.jobs().enqueue('danbooru-sync');
            if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
            // 开着画师的：接着补（新图、WD 识别的旧图、重启前没补完的）；用户取消过就等他手动再点
            const a = this.d.artists;
            if (this.canAutoArtists()) this.d.jobs().enqueue('artists');
            // 放在最后：enqueue 会马上启动空闲的 io 道，先排的话 Pixiv 会抢在同步、查重前面
            this.maybePixiv();
          }
          return msg;
        }
        case 'pixiv-tags': {
          if (!this.d.pixiv) throw new NotImplementedError('pixiv', 'Pixiv 角色补充');
          // 手动点的（含让出后的续跑）关着也跑；自动排上的到开跑时再查一次：排队期间用户可能关掉了开关
          if (!this.pixivManual && (!this.d.pixiv.enabled() || this.pixivPaused)) return '补充 Pixiv 角色：设置里没有打开';
          try {
            const msg = await this.d.pixiv.run(ctx);
            // 让出时不排 Danbooru 同步，等续跑的那一轮跑完再排
            if (!ctx.signal.aborted && !ctx.yielded && this.d.danbooru?.shouldRunAfterTag()) this.d.jobs().enqueue('danbooru-sync');
            return msg;
          } catch (error) {
            this.pixivFailed = true;
            throw error;
          } finally {
            if (ctx.signal.aborted) this.pixivPaused = true;
            // 这一轮结束了（不是让出）：手动标记用完
            if (!ctx.yielded) this.pixivManual = false;
          }
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
      const t = setTimeout(() => {
        // 这期间别的扫描（监听触发的）可能已经把这些目录取走了：没有待扫的就不排，空请求会被当成全量扫描
        if (this.d.requests.pending) this.d.jobs().enqueue('scan', { requeueIfRunning: true });
      }, DEFERRED_RETRY_MS);
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

  /** 显式导入已经完成入库，接续像素处理和识别，不重复扫描。 */
  afterImport(): void {
    this.dedupeDirty = true;
    this.requestTag();
    this.d.jobs().enqueue('thumbnail');
  }

  /** 启动时发现从没查过重、或查重之后又有新图：下次任务链走到时补跑查重 */
  markDedupeDirty(): void {
    this.dedupeDirty = true;
  }

  /** 用户手动开始某个任务（取消识别后再点「运行识别」→ 恢复自动续跑） */
  noteManualStart(kind: JobKind): void {
    if (kind === 'tag') {
      this.tagPaused = false;
      this.tagManual = true;
      this.pixivFailed = false;
    }
    if (kind === 'artists') this.artistsPaused = false;
    if (kind === 'pixiv-tags') { this.pixivPaused = false; this.pixivFailed = false; this.pixivManual = true; }
  }

  private afterThumbnail() {
    // 模型还没下载时 isReady() 为 false：不会自动触发 1.26 GB 的下载，用户点「运行识别」才开始
    // 查重只依赖缩略图阶段算好的 dHash，先跑（几秒），不用等识别跑完（CR-14）
    if (this.dedupeDirty) this.d.jobs().enqueue('dedupe');
    this.maybeTag();
  }

  private maybeTag() {
    const t = this.d.tag;
    const tagNeeded = !!t?.isReady() && t.pendingCount() > 0;
    if (tagNeeded && !this.tagPaused) this.d.jobs().enqueue('tag');
    // 识别确实不用跑（比如重启后）才接着补画师；识别被用户暂停时也不接，免得新图先被 PixAI 跑一遍画师、恢复识别后再跑一遍
    else if (!tagNeeded && this.canAutoArtists()) this.d.jobs().enqueue('artists');
    if (!tagNeeded && !this.tagPaused) this.maybePixiv();
  }

  private maybePixiv(requeueIfRunning = true): void {
    const p = this.d.pixiv;
    // 自动补充会把投稿 ID 发给 pixiv.net：设置里打开了才排（手动点按钮走 startJob，不经过这里）
    if (p?.enabled() && !this.pixivPaused && !this.pixivFailed && p.pendingCount() > 0)
      this.d.jobs().enqueue('pixiv-tags', { requeueIfRunning });
  }

  /**
   * 设置里刚打开自动查 Pixiv：清掉之前的暂停和失败，有积压的就排一轮。
   * 正在跑的（用户手动点的）不再追加一轮，剩下的等下次识别完再补
   */
  requestPixiv(): void {
    this.pixivPaused = false;
    this.pixivFailed = false;
    this.maybePixiv(false);
  }

  /** 正在跑或排着的 Pixiv 补充是用户点按钮开始的：关掉设置时只取消自动排上的 */
  isPixivManual(): boolean {
    return this.pixivManual;
  }

  private canAutoArtists(): boolean {
    const a = this.d.artists;
    return !!a && a.enabled() && a.isReady() && !this.artistsPaused && a.pendingCount() > 0;
  }

  /**
   * 有图需要识别了（比如图库文件夹从「按漫画导入」改回来）：模型在、用户没暂停、有待识别的图时排上；
   * 正在识别也再排一轮（这一轮的游标可能已经走过这些图）
   */
  requestTag(): void {
    const t = this.d.tag;
    if (t?.isReady() && !this.tagPaused && t.pendingCount() > 0) this.d.jobs().enqueue('tag', { requeueIfRunning: true });
  }

  /**
   * 有图改回了自动识别画师：能自动续补时（开着、模型在、用户没暂停）排一轮；正在跑也再排一轮，
   * 游标已经走过的图这一轮挑不到。用户暂停过就等他手动点「补跑」
   */
  requestArtists(): void {
    if (this.canAutoArtists()) this.d.jobs().enqueue('artists', { requeueIfRunning: true });
  }

  /** 用户取消了排队中的任务（runner 不会执行，收不到 aborted）：同样记暂停 */
  notePaused(kind: JobKind): void {
    if (kind === 'tag') this.tagPaused = true;
    if (kind === 'artists') this.artistsPaused = true;
    if (kind === 'pixiv-tags') {
      this.pixivPaused = true;
      this.pixivManual = false;
    }
  }
}
