import { editedSource } from '../../services/source/editSource.ts';
import type {
  AddLibraryRootBody,
  BulkCollectionsBody,
  Artist,
  BulkImagesBody,
  CollectionSummary,
  CreateCollectionBody,
  GetCollectionResponse,
  ListCollectionsQuery,
  UpdateCollectionBody,
  Character,
  ContentKind,
  ContentKindSummary,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CustomCharacterMatch,
  CreateExclusionBody,
  DuplicateGroup,
  Exclusion,
  GetCharacterResponse,
  ID,
  ImageDetail,
  ImageItem,
  ImportImagesBody,
  ImportImagesResult,
  ReplaceImageBody,
  ReplaceImageResult,
  Job,
  JobKind,
  StartJobBody,
  LibraryStats,
  ListCharactersQuery,
  ListCharactersResponse,
  ListDuplicatesQuery,
  ListImagesQuery,
  ListUnrecognizedQuery,
  ListUnrecognizedResponse,
  ListWorksQuery,
  MoveImagesBody,
  MutationResult,
  UndoTokenStatus,
  Page,
  RetagResult,
  SearchHit,
  SearchQuery,
  TagSuggestion,
  TagSuggestionsQuery,
  Settings,
  ThumbWidth,
  TopCharactersQuery,
  UnrecognizedItem,
  UnrecognizedSummary,
  UnrecognizedSummaryQuery,
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
  UpdateLibraryRootBody,
  UpdateArtistLinksBody,
  Rating,
  Work,
  PromotableSuggestions,
  ChangeEntry,
  ChangeGroup,
  MovePreview,
  SourceModePreview,
} from '@emaki/shared';
import { REMOVED_ROOT_KEEP_DAYS } from '@emaki/shared';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EventBus } from '../../core/events.ts';
import { JobQueue, type JobContext } from '../../core/jobs.ts';
import { done, UndoStack } from '../../core/undo.ts';
import { closeDatabase, openDatabase, type Db } from '../../db/connection.ts';
import { OfflineCharacterIndex } from '../../services/catalog/offlineCharacters.ts';
import { migrate } from '../../db/migrate.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { SoftCache } from './softCache.ts';
import { consolidateCharacterTags, consolidateWorkTags } from '../../domain/catalog/consolidate.ts';
import { BadRequestError, ConflictError, NeedsConfirmError, NotFoundError, NotImplementedError } from '../../http/errors.ts';
import type { DataSource, FileResponse } from '../DataSource.ts';
import { parentRel, toAbs } from '../../services/fs/paths.ts';
import { revealInFileManager } from '../../services/fs/reveal.ts';
import { ThumbnailService } from '../../services/image/ThumbnailService.ts';
import { thumbPath } from '../../services/image/pixels.ts';
import { Pipeline } from '../../services/pipeline.ts';
import { Scanner } from '../../services/scan/Scanner.ts';
import { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { applySourceChanges, backfillSources, diffSources, markSourcesCurrent } from '../../services/source/backfill.ts';
import { ChangeLog, recordChange, type MovePayload } from './changeLog.ts';
import { htmlAnimationCache, readHtmlAnimation } from '../../services/image/htmlAnimation.ts';
import { sha256Buffer } from '../../services/fs/hash.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { recordRootModeUndo, syncRootModes } from '../../services/classify/rootMode.ts';
import type { UndoRecorder } from './undo.ts';
import { ComicAreas, IN_COMIC } from '../../services/classify/comicAreas.ts';
import { CollectionService } from '../../domain/collections/CollectionService.ts';
import { collectionReactions } from '../../domain/collections/reactions.ts';
import { reclassifyByPathReaction } from '../../domain/analysis/reactions.ts';
import { catalogReactions } from '../../domain/catalog/reactions.ts';
import { declareTagged, dropStalePixivEvidenceReaction, queuePixivCheckReaction, reparseSourceReaction } from '../../domain/evidence/reactions.ts';
import { runAs, type Actor } from '../../propagation/actor.ts';
import type { Change } from '../../propagation/changes.ts';
import { ChangeEvents, engineReactions, type EngineHooks } from '../../propagation/engine.ts';
import { clearWork, hasWork, markWork, peekWork } from '../../propagation/work.ts';
import { shutdownTagger } from '../../services/tagger/client.ts';
import { ARTIST_MODEL, artistPendingCount, createArtistJobRunner } from '../../services/tagger/artists.ts';
import { isModelReady } from '../../services/tagger/download.ts';
import { findModel } from '../../services/tagger/models.ts';
import { createTagStage } from '../../services/tagger/tagJob.ts';
import { resetIoBackoff } from '../../services/tagger/readBackoff.ts';
import { CharacterCatalog } from '../../domain/catalog/characterCatalog.ts';
import type { CharacterVerification } from '../../services/catalog/characterVerification.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { createDanbooruSyncRunner, hasUncachedArtists, hasUncachedCharacterTags } from '../../services/danbooru/sync.ts';
import { importDictIfNeeded } from '../../services/i18n/dict.ts';
import { SqliteLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { relocalizeAll } from '../../domain/catalog/relocalize.ts';
import { LibraryWatcher, type WatchedRoot } from '../../services/watch/LibraryWatcher.ts';
import { config } from '../../config.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import { listImages } from './queries/listImages.ts';
import { loadSuggestions } from './suggestions.ts';
import { replaceCharacters } from '../../domain/curation/links.ts';
import { setFavorite, setRating } from '../../domain/curation/marks.ts';
import { manual } from '../../domain/curation/provenance.ts';
import { clearPendingPixivCache, pendingPixivCount, queuePixivImages, queueUnseenPixivAnimations, resetPixivBackoff, syncPixivCharacters } from '../../services/pixiv/sync.ts';
import { refreshPixivAliases } from '../../services/pixiv/aliases.ts';
import { createPixivDiscovery } from '../../services/pixiv/discovery.ts';
import { DanbooruClient } from '../../services/danbooru/client.ts';
import { BulkOps, RATING_LABEL } from './bulk.ts';
import { CollectionQueries } from './collections.ts';
import { assertKindValue, KIND_LABEL, setKindInTx, type KindDeps } from './kinds.ts';
import { countPromotable, promoteSuggestions } from '../../domain/curation/auto.ts';
import { describeKindReason } from './hydrate.ts';
import { DuplicateQueries } from './duplicates.ts';
import { SearchQueries } from './search.ts';
import { DedupeService } from '../../services/dedupe/DedupeService.ts';
import { PendingTrash } from './pendingTrash.ts';
import { resolvePorts, type EnginePorts, type ImageFileRow } from '../../infra/ports.ts';
import { CharacterMutations } from '../../domain/catalog/characters.ts';
import { setArtistLinks } from '../../domain/catalog/artists.ts';
import { UnrecognizedQueries } from './unrecognized.ts';
import { createContext } from './context.ts';
import { Derived } from './derived.ts';
import { ExclusionQueries, reevaluateExclusionsReaction } from '../../domain/visibility/exclusions.ts';
import { LibraryQueries } from './library.ts';
import { moveImageFiles, normalizeSubdir, type MoveRow } from './move.ts';
import { importImages } from './importImages.ts';
import { replaceImage } from './replaceImage.ts';
import { artistNames, imageArtists, linkGroups, listArtists as listArtistsQuery, tagNames } from './artists.ts';
import { artistLinksMessage, linkTags, planArtistLinks } from '../artistEdits.ts';
import { adoptFromRemovedParents, diskCaseRel, mergeChildRoots, relUnder, type ChildRoot } from './roots.ts';
import { applySettingsPatch, getDanbooruApiKey, isInside, normalizeRootPath, patchSettingsInternal, readSettings, rootPathKey, samePath } from './settings.ts';
import { iso, MIME, parseId, toId, VISIBLE } from './sql.ts';

/** 启动修补的 actor */
const STARTUP: Actor = 'system:startup';

/** 改图库文件夹的导入方式会改这些列（撤销用） */
const ROOT_MODE_COLS = ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'theme', 'art_score', 'rating'];
type RootImageSnap = { id: number; tagged_at: string | null } & Record<string, unknown>;

/**
 * 打开引擎的选项：可替换部件（infra/ports.ts，没给的用真实实现），加上存储和灌数据。
 * 测试一般给 { memory: true, autoJobs: false, importDict: false }；演示模式见 demo/engine.ts。
 */
export interface SqliteOpenOptions extends Partial<EnginePorts> {
  /** 内存库（测试用）；否则是 `${dataDir}/emaki.sqlite` */
  memory?: boolean;
  /**
   * 往刚迁移完的库里灌数据（演示数据、契约测试夹具）。在迁移之后、启动修补（来源和类型回填、合集重算、
   * 角色收拢、自动关联）之前执行，所以灌进来的数据和真实图库一样经过这些启动步骤
   */
  seed?: (db: Db) => void;
}

/**
 * 真实数据源：SQLite（better-sqlite3）+ 文件系统。
 *
 * 实现顺序和每个方法的验收标准见 docs/TASKS.md，方法上的 T 编号就是任务编号。
 * 这是业务逻辑唯一的实现：演示模式和测试也跑它，只是换掉会产生副作用的部件（infra/ports.ts，docs/core-architecture.md 第 8 节）。
 *
 * 依赖按 TASKS.md「关键技术决策」安装：T01 better-sqlite3、T03 sharp、T09 onnxruntime-node（精确锁定版本）；
 * 文件监听用 Node 自带的 fs.watch（不装 chokidar），相似查重用 MIH（不用 BK-tree）。
 */
export class SqliteDataSource implements DataSource {
  async replaceImage(id: ID, body: ReplaceImageBody): Promise<ReplaceImageResult> {
    this.requireLibraryFiles('替换图库里的文件');
    return replaceImage(this.ctx, id, body);
  }
  async importImages(body: ImportImagesBody): Promise<ImportImagesResult> {
    this.requireLibraryFiles('导入文件');
    return importImages(this.ctx, body, { trashImpl: this.ports.trashImpl });
  }
  /** 可替换部件（infra/ports.ts） */
  readonly ports: EnginePorts;
  /** 数据库文件；内存库是 null。AI 助手的只读 SQL 直接读它 */
  readonly databaseFile: string | null;

  /** 演示模式（libraryFiles = false）下拒绝会改动用户图库文件夹的操作 */
  private requireLibraryFiles(action: string): void {
    if (!this.ports.libraryFiles) throw new BadRequestError(`演示数据不支持${action}`);
  }
  /**
   * T01：打开 / 创建 `${dataDir}/emaki.sqlite`，开启 WAL 和外键，跑迁移（db/migrate.ts），
   * 创建 UndoStack 和 JobQueue（runner 由 T07 接上 services/*）。
   */
  static async open(bus: EventBus, dataDir: string, opts: SqliteOpenOptions = {}): Promise<SqliteDataSource> {
    await mkdir(dataDir, { recursive: true });
    const db = openDatabase(opts.memory ? ':memory:' : path.join(dataDir, 'emaki.sqlite'));
    migrate(db, { backupDir: opts.memory ? undefined : dataDir, log: (m) => console.log(m) });
    if (opts.seed) opts.seed(db);
    db.pragma('optimize = 0x10002'); // 长连接：打开时一次，之后每小时一次
    // 启动时不精确数 image_tags（冷缓存下 2 秒多）；识别跑完、每小时那次照常数
    if (refreshPlannerStats(db, { skipImageTags: true })) console.log('[db] 行数变化较大，已重新采样查询统计');
    const ds = new SqliteDataSource(db, bus, dataDir, opts);
    // 启动修补都记在 system:startup 名下：弱刷新，合集这类全量重算延后到 library.opened 一次做完
    return runAs(STARTUP, () => ds.startup(opts));
  }

  private async startup(opts: SqliteOpenOptions): Promise<SqliteDataSource> {
    const ds = this;
    const { db, bus } = ds.ctx;
    const dataDir = ds.ctx.dataDir;
    ds.purgeRemovedRoots();
    // 来源解析规则升级后重算；来源变了的由反应清掉过期的 Pixiv 建议、重新登记补充
    ds.ctx.apply(() => ds.ctx.changed({ type: 'image.sourceChanged', ids: backfillSources(db).map((c) => c.id) }));
    // 内容类型 / 主题 / 质量分（T27）：规则版本过期的行在 HTTP 监听前同步重算；EMAKI_CLASSIFY=0 跳过（全部按插画统计，保持旧值）
    if (process.env.EMAKI_CLASSIFY !== '0') {
      const r = backfillClassification(db);
      if (r.rows) console.log(`[classify] 重算图片类型 ${r.rows} 张，用时 ${r.ms} ms`);
    }
    // 分类回填之后、HTTP 监听之前：派生数据整体对一遍（全量重算合集 T38b、按规则重新判定排除结果）
    ds.ctx.apply(() => ds.ctx.changed({ type: 'library.opened', ids: [] }));
    if (ds.ports.autoJobs) ds.startWatching();
    ds.autoTag = ds.ports.autoJobs;
    // 识别角色（T10）。T11 / T20 之后在这里继续 register
    // 角色 → 作品的完整回退链 + 标签规范化（改名、服装变体归本体）来自 Danbooru 缓存（T11）
    const offlineCharacters = opts.memory ? undefined : OfflineCharacterIndex.open(dataDir);
    const danbooru = new DanbooruCatalog(db, CopyrightResolver.fromAsset(db), offlineCharacters);
    if (offlineCharacters) console.log('[character-index] 已加载离线角色索引');
    // 中文名（T12）：随仓库分发的词库，版本变了才重新导入；导入后全库重算显示名
    const dict = ds.ports.importDict ? importDictIfNeeded(db) : { imported: false };
    const localizer: Localizer = new SqliteLocalizer(db, danbooru);
    ds.localizer = localizer;
    if (dict.imported) db.transaction(() => relocalizeAll(db, localizer))();
    const makeCatalog = () => ({
      catalog: new CharacterCatalog(db, { copyrights: danbooru, localizer, verifications: danbooru.verifications, normalizeTag: (t) => danbooru.normalizeTag(t) }),
      copyrights: danbooru,
    });
    ds.danbooru = danbooru;
    ds.makeCatalog = makeCatalog;
    // 同一个角色被拆成好几个的收拢（换模型后的改名、服装变体归本体；用户 2026-09-28）。已经收拢过就什么也不做
    const merged = consolidateCharacterTags(db, {
      normalizeTag: (t) => danbooru.normalizeDanbooruTag(t),
      localizer,
      merge: (from, to) => void ds.characters.merge(String(from), String(to)),
      log: (m) => console.log(`[角色] ${m}`),
    });
    if (merged.merged || merged.renamed) console.log(`[角色] 收拢拆开的角色：合并 ${merged.merged} 个，改标签 ${merged.renamed} 个`);
    // 作品同理：Danbooru 改过名的版权标签，新旧两个名字各建了一部（用户 2026-09-29）
    const works = consolidateWorkTags(db, { canonicalize: (t) => danbooru.canonicalize(t), localizer });
    if (works.merged || works.renamed) console.log(`[作品] 收拢改过名的作品：合并 ${works.merged} 部，改标签 ${works.renamed} 部`);
    ds.characters.associateAutomatic();
    ds.pipeline.register({
      tag: createTagStage({
        db,
        bus,
        modelsDir: config.modelsDir,
        getTaggerSettings: () => readSettings(db).tagger,
        makeCatalog,
        // 每批写完（在 writer 的事务里）：声明证据、角色、类型变了，套排除规则、登记 Pixiv 补充等由反应做
        afterBatchInTx: (ids, changes) => declareTagged(ds.ctx, ids, changes),
        log: (m) => console.info(`[tag] ${m}`),
      }),
      pixiv: {
        // 识别后自动查 Pixiv 会联网，设置里打开才排；待查的图照常登记（只写本地），打开后接着补
        enabled: () => readSettings(db).tagger.pixiv,
        pendingCount: () => pendingPixivCount(ds.ctx),
        run: async (job) => {
          const settings = readSettings(db).danbooru;
          if (settings.enabled && pendingPixivCount(ds.ctx) > 0) {
            try {
              await refreshPixivAliases(db, danbooru, new DanbooruClient({
                login: settings.username || undefined, apiKey: getDanbooruApiKey(db) ?? undefined,
              }), job);
            } catch (error) {
              job.signal.throwIfAborted();
              console.warn(`[pixiv-tags] 别名补全失败，本轮使用已有词库：${String(error)}`);
            }
          }
          const discovery = settings.enabled ? createPixivDiscovery(db, danbooru, new DanbooruClient({
            login: settings.username || undefined, apiKey: getDanbooruApiKey(db) ?? undefined,
          })) : undefined;
          const result = await syncPixivCharacters(ds.ctx, job, makeCatalog, undefined, 1000, discovery);
          ds.characters.associateAutomatic();
          return result;
        },
      },
      danbooru: {
        shouldRunAfterTag: () => readSettings(db).danbooru.enabled && (hasUncachedCharacterTags(db) || hasUncachedArtists(db)),
        run: createDanbooruSyncRunner({
          db,
          danbooru,
          getCatalog: () => makeCatalog().catalog,
          localizer,
          relocalizeAll,
          getDanbooru: () => ({ ...readSettings(db).danbooru, apiKey: getDanbooruApiKey(db) }),
          associateCustomCharacters: () => ds.characters.associateAutomatic(),
          setLastSyncAt: (at) => patchSettingsInternal(db, 'danbooru', { lastSyncAt: at }),
        }),
      },
    });
    ds.pipeline.register({
      artists: {
        enabled: () => readSettings(db).tagger.artists,
        // 模型没下载（主模型用 WD 的人）时不自动续补，免得静默下载 1 GB、离线时反复失败；手动打开 / 点补跑才下
        isReady: () => isModelReady(findModel(ARTIST_MODEL)!, config.modelsDir),
        pendingCount: () => artistPendingCount(db),
        run: createArtistJobRunner({
          db,
          modelsDir: config.modelsDir,
          getDevice: () => {
            const t = readSettings(db).tagger;
            return { device: t.device, batchSize: t.batchSize };
          },
        }),
      },
    });
    // 查重（T16）
    ds.pipeline.register({ dedupe: ds.dedupe });
    // 从没查过重，或查重之后又有新缩略图（重启丢了进程里的标记）→ 下次有机会就查（T26）
    const lastRunAt = readSettings(db).dedupe.lastRunAt;
    const lastThumb = db.prepare('SELECT MAX(thumb_at) FROM images').pluck().get() as string | null;
    if (lastThumb !== null && (lastRunAt === null || lastThumb > lastRunAt || ds.dedupe.needsRecheck())) ds.pipeline.markDedupeDirty();
    // 搜索的标签张数（T20）：打标签结束标记过期，下次搜索时刷新
    // register 是覆盖式的：扫描结束后的钩子写在这一处。识别、扫描结束后的合集重算由变更传播在任务结束时做
    // （有变化才做，RV-C-9：延后重扫大约 3 秒一次，没变化时不要全量读库）
    ds.pipeline.register({
      afterScan: () => {
        // 扫描按开始时的导入方式判类型：中途切换过的、在磁盘上移进移出漫画文件夹的，按现在的设置改过来
        ds.ctx.apply(() => {
          if (syncRootModes(db, undefined, (c) => ds.ctx.changed(c))) ds.ctx.changed({ type: 'root.modeChanged', rootIds: [], ids: [] });
        });
      },
    });
    // Register old animations locally as well; network scheduling still follows
    // the user's Pixiv setting and the normal pipeline.
    queueUnseenPixivAnimations(ds.ctx);
    const roots = db.prepare('SELECT COUNT(*) FROM library_roots WHERE enabled = 1 AND removed_at IS NULL').pluck().get() as number;
    if (ds.ports.autoJobs && !process.env.EMAKI_NO_AUTOSCAN && roots > 0) {
      ds.requests.requestFull();
      ds.ctx.jobs.enqueue('scan');
    }
    // 上次没正常退出时留下的待移文件：现在移进系统回收站（撤销栈已经随重启清空了）
    void ds.pendingTrash.flushAll();
    return ds;
  }

  /** 测试和脚本通过 ds.ctx.db 访问数据库 */
  readonly ctx: ReturnType<typeof createContext>;
  private readonly optimizeTimer: NodeJS.Timeout;
  /** 缩略图（T04） */
  readonly thumbs: ThumbnailService;
  /** 待扫描的范围（全量 / T08 的脏目录） */
  readonly requests = new ScanRequests();
  readonly scanner: Scanner;
  /** 后台任务链（T07）；后续任务通过 pipeline.register 注入自己的阶段 */
  readonly pipeline: Pipeline;
  /** Danbooru 缓存（T11）；T14 用它重算自建角色匹配 */
  danbooru!: DanbooruCatalog;
  private localizer!: Localizer;
  /** 每次新建一个带完整回退链的角色目录（缓存只在一次请求内有效） */
  makeCatalog!: () => { catalog: CharacterCatalog; copyrights: DanbooruCatalog };
  private readonly characters: CharacterMutations;
  private readonly unrecognized: UnrecognizedQueries;
  private readonly bulk: BulkOps;
  /** 移到回收站的延后执行（最近几次可撤销） */
  readonly pendingTrash: PendingTrash;
  private readonly kindDeps: KindDeps;
  /** 合集（T38b）；什么时候重算由变更传播的反应决定（domain/collections/reactions.ts） */
  readonly collections: CollectionService;
  /** library-changed 的推送（按 actor 节流） */
  private readonly events: ChangeEvents;
  private readonly duplicates: DuplicateQueries;
  /** ⌘K 搜索（T20） */
  readonly searchQueries: SearchQueries;
  /** 查重（T16） */
  readonly dedupe: DedupeService;
  /** 角色 / 作品聚合缓存（T13） */
  readonly derived: Derived;
  /** 统计、别册汇总、图片总数的两级失效缓存（T22） */
  private readonly results: SoftCache<unknown>;
  private readonly library: LibraryQueries;
  private readonly collectionQueries: CollectionQueries;
  private readonly exclusions: ExclusionQueries;
  /** 最近的改动：自动关联、Pixiv 补充、移动到文件夹（重启后也能撤回） */
  private readonly changes: ChangeLog;

  protected constructor(db: Db, bus: EventBus, dataDir: string, opts: SqliteOpenOptions) {
    this.ports = resolvePorts(opts);
    this.databaseFile = opts.memory ? null : path.join(dataDir, 'emaki.sqlite');
    const jobRunner = this.ports.jobRunner;
    // 任务结束（完成、让出、取消、失败）：变更传播做掉延后的全量重算（合集），推 library-changed（reason 是任务种类）
    const jobs = new JobQueue(
      bus,
      (kind) => (jobRunner ? jobRunner(kind) : this.pipeline.runner(kind)),
      (kind) => this.ctx.propagation.jobFinished(kind),
    );
    this.ctx = createContext({ db, bus, dataDir, clock: this.ports.clock, undo: new UndoStack(), jobs });
    this.events = new ChangeEvents(bus);
    this.ctx.propagation.onJobFinished((kind) => this.events.flush(kind));
    // 扫描、缩略图任务在 apply 里写库并声明变化
    const changes = { apply: <T,>(fn: (emit: (c: Change) => void) => T): T => this.ctx.apply(() => fn((c) => this.ctx.changed(c))) };
    this.thumbs = new ThumbnailService({ db, thumbsRoot: path.join(dataDir, 'thumbs', 'v1'), now: this.ctx.clock, changes });
    this.scanner = new Scanner({ db, bus, dataDir, requests: this.requests, changes });
    this.pipeline = new Pipeline({
      jobs: () => this.ctx.jobs,
      requests: this.requests,
      scanner: this.scanner,
      thumbs: this.thumbs,
      pixelPendingCount: () => this.thumbs.pendingCount(),
      // 「要查重」持久化在 pending_work（附录 #18）
      dedupeWork: {
        pending: () => hasWork(db, 'dedupe'),
        mark: () => markWork(db, 'dedupe', iso(this.ctx.clock())),
        peek: () => peekWork(db, 'dedupe'),
        done: (seen) => clearWork(db, 'dedupe', seen),
      },
    });
    // 后台任务写库后，统计类结果最多晚 10 秒更新（T22）；测试（内存库）里不延迟
    const softMs = opts.memory ? 0 : 10_000;
    this.results = new SoftCache<unknown>({ softMs, maxMs: 5 * 60_000, max: 200 });
    this.derived = new Derived(this.ctx, softMs);
    this.collections = new CollectionService(db, this.ctx.clock);
    this.collectionQueries = new CollectionQueries(this.ctx, this.collections, this.derived, () => this.makeCatalog().catalog);
    this.library = new LibraryQueries(this.ctx, this.derived, () => this.collectionQueries.stats());
    this.kindDeps = { catalog: () => this.makeCatalog().catalog, autoAcceptThreshold: () => readSettings(db).tagger.autoAcceptThreshold };
    this.pendingTrash = new PendingTrash(this.ctx, { trashImpl: this.ports.trashImpl, checkRoot: this.ports.checkRecyclable });
    this.bulk = new BulkOps(this.ctx, (ids) => this.requireVisibleImages(ids), this.kindDeps, this.pendingTrash);
    this.unrecognized = new UnrecognizedQueries(this.ctx, () => this.makeCatalog().catalog, softMs);
    this.characters = new CharacterMutations(this.ctx, this.derived, () => this.danbooru, () => this.makeCatalog().catalog);
    this.exclusions = new ExclusionQueries(this.ctx);
    this.changes = new ChangeLog(this.ctx);
    this.duplicates = new DuplicateQueries(this.ctx, this.pendingTrash);
    this.searchQueries = new SearchQueries(db, this.derived);
    this.dedupe = new DedupeService({
      db,
      clock: this.ctx.clock,
      getThreshold: () => readSettings(db).dedupe.hammingThreshold,
      onChanged: () => this.ctx.apply(() => this.ctx.changed({ type: 'duplicates.changed', ids: [] })),
      onFinished: (at) => patchSettingsInternal(db, 'dedupe', { lastRunAt: at }),
    });
    // 缓存只由变更传播的提交后反应让它失效：用户和助手的操作硬失效，后台任务和启动修补软失效（附录 #20、#21）
    this.ctx.onInvalidate((_scope, o) => {
      this.derived.invalidate(o.soft);
      this.unrecognized.invalidate(o.soft);
      this.results.invalidate(o.soft);
      this.searchQueries.markStale();
    });
    this.registerReactions();
    // 扫描 / 识别跑完后行数可能变了很多（首次导入）：查询统计过期会让列表走错计划（T22）
    bus.subscribe((e) => {
      if (e.type === 'job' && e.job.status === 'done' && (e.job.kind === 'scan' || e.job.kind === 'tag')) refreshPlannerStats(db);
    });
    this.optimizeTimer = setInterval(() => {
      db.pragma('optimize');
      refreshPlannerStats(db);
    }, 3_600_000);
    this.optimizeTimer.unref();
  }

  /**
   * 反应注册表（docs/core-architecture.md 第 5.2 节，docs/ARCHITECTURE.md「变更传播」）。同一阶段按这里的顺序执行：
   * 事务内：重新解析来源 → 路径相关的分类 → 过期的 Pixiv 建议 → 排除结果 → Pixiv 补充登记 → 同投稿组 → 文件夹合集 → 合集页序；
   * 排队：查重标记、识别、缩略图、画师、Pixiv、本地重新匹配、重新扫描；提交后：全量合集、自建角色匹配、设置和文件夹监听、缓存和事件
   */
  private registerReactions(): void {
    const db = this.ctx.db;
    const p = this.ctx.propagation;
    const visible = (rootId: number) => !!db.prepare('SELECT 1 FROM library_roots WHERE id = ? AND enabled = 1 AND removed_at IS NULL').get(rootId);
    const hooks: EngineHooks = {
      requestTag: () => this.requestTag(),
      // 新图、换了文件：接着做像素处理和识别，标记要查重（任务链的 afterImport，不重复扫描）
      requestThumbnails: () => this.pipeline.afterImport(),
      requestArtists: () => this.pipeline.requestArtists(),
      requestPixiv: () => this.pipeline.requestPixivAuto(),
      requestDedupe: (rootIds) => {
        if (rootIds.some(visible) && readSettings(db).dedupe.lastRunAt !== null) this.ctx.jobs.enqueue('dedupe');
      },
      rescanRoots: (ids) => {
        for (const id of ids) if (visible(id)) this.rescanRoot(id);
      },
      rematchPixiv: (ids) => this.rematchCachedPixiv(ids),
      settingsChanged: () => {
        void this.getSettings().then((settings) => {
          for (const fn of this.settingsListeners) fn(settings);
        });
      },
      rootsChanged: () => {
        for (const fn of this.rootsListeners) fn();
      },
      pendingTag: (ids) =>
        !!ids.length &&
        !!db
          .prepare(
            `SELECT 1 FROM images i WHERE i.id IN (SELECT value FROM json_each(?)) AND (i.tagged_at IS NULL OR i.retag = 1)
             AND i.excluded_by IS NULL AND i.trashed_at IS NULL AND i.missing = 0 AND NOT ${IN_COMIC('i')} LIMIT 1`,
          )
          .get(JSON.stringify(ids)),
      pendingArtists: (ids) =>
        !!ids.length &&
        !!db.prepare('SELECT 1 FROM images WHERE id IN (SELECT value FROM json_each(?)) AND artist_manual = 0 AND artist_checked_at IS NULL LIMIT 1').get(JSON.stringify(ids)),
      pendingPixiv: () => pendingPixivCount(this.ctx) > 0,
    };
    const engine = engineReactions(hooks, this.events);
    p.register(
      reparseSourceReaction,
      reclassifyByPathReaction,
      dropStalePixivEvidenceReaction,
      reevaluateExclusionsReaction,
      queuePixivCheckReaction,
      ...collectionReactions(this.collections, p),
      ...engine.queue,
      ...catalogReactions(() => this.danbooru),
      ...engine.after,
    );
  }

  /** 文件监听（T08）；测试里 autoJobs=false 时不启动 */
  private watcher: LibraryWatcher | null = null;
  /** 改回插画后自动排识别；测试里（autoJobs=false）不排，免得在测试里加载真的识别模型 */
  private autoTag = true;
  private requestTag(): void {
    if (this.autoTag) this.pipeline.requestTag();
  }

  private watchedRoots(): WatchedRoot[] {
    return (this.ctx.db.prepare('SELECT id, path FROM library_roots WHERE enabled = 1 AND removed_at IS NULL').all() as { id: number; path: string }[]).map(
      (r) => ({ ...r, enabled: true }),
    );
  }

  private startWatching(): void {
    this.watcher = new LibraryWatcher({
      requests: this.requests,
      enqueueScan: () => this.ctx.jobs.enqueue('scan', { requeueIfRunning: true }),
      dataDir: this.ctx.dataDir,
      log: (m, e) => console.warn(m, e instanceof Error ? e.message : (e ?? '')),
      known: (rootId, rel) =>
        this.ctx.stmt('SELECT bytes, modified_at FROM images WHERE root_id = ? AND rel_path = ?').get(rootId, rel) as
          | { bytes: number; modified_at: string }
          | undefined,
    });
    this.watcher.sync(this.watchedRoots());
    this.onRootsChanged(() => this.watcher?.sync(this.watchedRoots()));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.events.close();
    // 还能撤销的回收站操作：退出前真的移进系统回收站
    await this.pendingTrash.flushAll();
    await shutdownTagger(); // 关掉推理子进程，释放显存
    clearInterval(this.optimizeTimer);
    this.danbooru?.offlineCharacters?.close();
    closeDatabase(this.ctx.db);
  }

  /** 画师：同一个人的不同标签合并，名字用 Danbooru 资料里的日文 / 汉字名（sqlite/artists.ts） */
  async listArtists(): Promise<Artist[]> {
    return listArtistsQuery(this.ctx.db);
  }

  /** 自动合并猜错了：手动拆开 / 合并画师，或者恢复自动（可撤销） */
  async updateArtistLinks(body: UpdateArtistLinksBody): Promise<MutationResult> {
    const db = this.ctx.db;
    const into = body.mode === 'merge' ? body.into?.trim() : undefined;
    if (body.mode === 'merge' && !into) throw new BadRequestError('要合并到哪位画师？');
    const given = linkTags(body.tags, into);
    const { groups } = linkGroups(db, [...given, ...(into ? [into] : [])]);
    const tags = planArtistLinks(body.mode, given, into, groups);
    const names = body.mode === 'split' ? tagNames(db, tags) : artistNames(db, given);
    const intoName = into ? artistNames(db, [into])[0] : undefined;
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      setArtistLinks(db, u, body.mode, tags, into ?? null, now);
      return { message: artistLinksMessage(body.mode, names, intoName) };
    });
  }

  // T38c 合集
  async listCollections(query: ListCollectionsQuery): Promise<CollectionSummary[]> {
    return this.collectionQueries.list(query);
  }
  async getCollection(id: ID): Promise<GetCollectionResponse | null> {
    return this.collectionQueries.get(id);
  }
  async createCollection(body: CreateCollectionBody): Promise<MutationResult & { collection: CollectionSummary }> {
    if (body.organizeFiles) this.requireLibraryFiles('整理到子文件夹');
    return this.collectionQueries.create(body);
  }
  async updateCollection(id: ID, body: UpdateCollectionBody): Promise<MutationResult> {
    if (body.organizeFiles) this.requireLibraryFiles('整理到子文件夹');
    return this.collectionQueries.update(id, body);
  }
  async deleteCollection(id: ID): Promise<MutationResult> {
    return this.collectionQueries.dismiss(id);
  }
  async bulkCollections(body: BulkCollectionsBody): Promise<MutationResult> {
    return this.collectionQueries.bulk(body);
  }

  // T13 统计 / 作品 / 角色查询
  async getStats(): Promise<LibraryStats> {
    return this.results.get('stats', () => this.library.getStats()) as LibraryStats;
  }
  async listContentKinds(): Promise<ContentKindSummary[]> {
    return this.results.get('kinds', () => this.library.listContentKinds()) as ContentKindSummary[];
  }
  async listWorks(query: ListWorksQuery): Promise<Work[]> {
    return this.library.listWorks(query);
  }
  async getWork(id: ID): Promise<Work | null> {
    return this.library.getWork(id);
  }
  async listCustomCharacterMatches(): Promise<CustomCharacterMatch[]> {
    const rows = this.ctx.db.prepare(`SELECT c.id, c.name, m.danbooru_tag AS tag
      FROM custom_character_matches m JOIN characters c ON c.id = m.character_id
      WHERE c.source = 'custom' AND c.danbooru_tag IS NULL AND m.dismissed = 0 ORDER BY c.name, c.id`).all() as { id: number; name: string; tag: string }[];
    const catalog = this.makeCatalog().catalog;
    return rows.map((r) => {
      const tag = this.danbooru.normalizeTag(r.tag);
      const described = catalog.describeTag(tag);
      return { characterId: String(r.id), characterName: r.name, danbooruTag: tag, matchName: described.name,
        workName: described.workName, existingCharacterId: described.characterId === null ? null : String(described.characterId),
        existingCharacterName: described.characterId === null ? null : described.name };
    });
  }
  async listCharacters(query: ListCharactersQuery): Promise<ListCharactersResponse> {
    return this.library.listCharacters(query);
  }
  async topCharacters(query: TopCharactersQuery): Promise<Character[]> {
    return this.library.topCharacters(query);
  }
  async getCharacter(id: ID): Promise<GetCharacterResponse | null> {
    return this.library.getCharacter(id);
  }
  async listCoverCandidates(id: ID, limit: number): Promise<CoverCandidatesResponse> {
    const res = this.library.listCoverCandidates(id, limit);
    if (!res) throw new NotFoundError('角色');
    return res;
  }

  // T14 角色编辑 / 合并 / 自建角色
  async createCharacter(body: CreateCharacterBody): Promise<MutationResult & { character: Character }> {
    return this.characters.create(body);
  }
  async updateCharacter(id: ID, body: UpdateCharacterBody): Promise<MutationResult> {
    return this.characters.update(id, body);
  }
  async markCharacterSeen(id: ID): Promise<void> {
    this.characters.markSeen(id);
  }
  async mergeCharacter(id: ID, targetId: ID): Promise<MutationResult> {
    return this.characters.merge(id, targetId);
  }
  async verifyCharacter(body: CharacterVerification): Promise<MutationResult> {
    return this.characters.verify(body, this.localizer);
  }

  // T05 图片查询与文件服务
  /** 可见的图（在 v_images 里，包括被排除的）；有一张不可见或不存在就 NotFoundError('图片') */
  protected requireVisibleImages(ids: ID[]): number[] {
    const nums = ids.map(parseId);
    if (nums.some((n) => n === null)) throw new NotFoundError('图片');
    const found = new Set(
      this.ctx.db
        .prepare('SELECT id FROM v_images WHERE id IN (SELECT value FROM json_each(?))')
        .pluck()
        .all(JSON.stringify(nums)) as number[],
    );
    if (nums.some((n) => !found.has(n!))) throw new NotFoundError('图片');
    return nums as number[];
  }

  protected requireCharacterId(id: ID): number {
    const n = parseId(id);
    if (n === null || !this.ctx.stmt('SELECT 1 FROM characters WHERE id = ?').get(n)) throw new NotFoundError('角色');
    return n;
  }

  async listImages(query: ListImagesQuery): Promise<Page<ImageItem>> {
    return listImages(this.ctx.db, query, (key, compute) => this.results.get('count:' + key, compute) as number);
  }

  async getImage(id: ID): Promise<ImageDetail | null> {
    const n = parseId(id);
    if (n === null) return null;
    const row = this.ctx
      .stmt(`SELECT ${IMAGE_COLS}, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ? AND ${VISIBLE}`)
      .get(n) as (ImageRow & { root_path: string }) | undefined;
    if (!row) return null;
    const [item] = hydrateImages(this.ctx.db, [row]);
    const tags = this.ctx
      .stmt(
        'SELECT t.name AS tag, t.category, it.score FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ? ORDER BY it.score DESC',
      )
      .all(n) as ImageDetail['tags'];
    return {
      ...item!,
      // 反斜杠的原生路径，方便用户复制
      absPath: path.normalize(toAbs(row.root_path, row.rel_path)),
      tags,
      characterSuggestions: loadSuggestions(this.ctx, [n], this.makeCatalog().catalog).get(n) ?? [],
      characterLinks: (
        this.ctx
          .stmt(
            `SELECT character_id, decision, evidence_provider, evidence_score FROM image_characters
             WHERE image_id = ? ORDER BY added_at, character_id`,
          )
          .all(n) as { character_id: number; decision: 'manual' | 'auto'; evidence_provider: 'tagger' | 'pixiv' | null; evidence_score: number | null }[]
      ).map((r) => ({ characterId: toId(r.character_id), decision: r.decision, source: r.evidence_provider, score: r.evidence_score })),
      kindSource: row.content_kind_manual ? 'manual' : row.content_kind_source,
      kindReason: row.content_kind_manual ? null : describeKindReason(row.content_kind_source, row.content_kind_evidence),
      collection: this.imageCollection(n),
      artists: imageArtists(this.ctx.db, n),
      sourceManual: !!this.ctx.stmt('SELECT source_manual FROM images WHERE id = ?').pluck().get(n),
      artistsManual: !!this.ctx.stmt('SELECT artist_manual FROM images WHERE id = ?').pluck().get(n),
    };
  }

  /** 看图器「收录于」：pageNo 是可见页里的序号（RV-C-8） */
  private imageCollection(imageId: number): ImageDetail['collection'] {
    const r = this.ctx
      .stmt(
        `SELECT c.id, c.kind, c.title, c.volume_no, c.rel_dir,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id AND x.page_no <= i.page_no) AS ord,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id) AS n
         FROM images i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.state = 'active'`,
      )
      .get(imageId) as
      | { id: number; kind: 'doujin' | 'artbook' | 'group'; title: string | null; volume_no: number | null; rel_dir: string; ord: number; n: number }
      | undefined;
    if (!r) return null;
    return {
      id: toId(r.id),
      kind: r.kind,
      title: r.title,
      pageNo: Math.max(1, r.ord),
      pageCount: r.n,
      volumeNo: r.volume_no,
      folderName: r.rel_dir.slice(r.rel_dir.lastIndexOf('/') + 1),
    };
  }

  async updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult> {
    const iid = this.requireVisibleImages([id])[0]!;
    if (body.kind !== undefined) assertKindValue(body.kind);
    const charIds = body.characterIds ? [...new Set(body.characterIds)].map((c) => this.requireCharacterId(c)) : null;
    const now = iso(this.ctx.clock());
    const sourceEdit = body.source === undefined ? undefined : editedSource(body.source, this.ctx.stmt('SELECT rel_path FROM images WHERE id = ?').pluck().get(iid) as string,
      readSettings(this.ctx.db).tagger.pixivFilenameMode);
    // 类型、收藏、分级、角色放进同一次 mutate：一起传时一个 token 撤销全部
    return this.ctx.mutate((u) => {
      // 提示文案：收藏 > 分级 > 角色 > 类型，只报一条
      let message = '';
      if (sourceEdit) {
        // 同投稿组的成员和页码要在改来源之前记下（撤销时放回原来的组）
        const oldKey = this.ctx.db.prepare("SELECT source_site || ':' || source_post_id FROM images WHERE id = ?").pluck().get(iid) as string | null;
        if (oldKey) u.columns('images', ['collection_id', 'page_no', 'collection_detached'], this.ctx.db.prepare("SELECT id FROM images WHERE source_site || ':' || source_post_id = ?").pluck().all(oldKey) as number[]);
        u.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url', 'source_manual'], [iid]);
        const src = sourceEdit.source;
        const before = this.ctx.db.prepare("SELECT COALESCE(source_site, '') || '|' || COALESCE(source_post_id, '') || '|' || COALESCE(source_artist, '') || '|' || COALESCE(source_url, '') FROM images WHERE id = ?").pluck();
        const was = before.get(iid);
        this.ctx.stmt('UPDATE images SET source_site=?, source_post_id=?, source_artist=?, source_url=?, source_manual=? WHERE id=?')
          .run(src?.site ?? null, src?.postId ?? null, src?.artist ?? null, src?.url ?? null, sourceEdit.manual ? 1 : 0, iid);
        // 刷新同投稿组、清过期的 Pixiv 建议、重新登记补充：和其他改来源的路径一样由反应做（附录 #13）
        if (before.get(iid) !== was) this.ctx.changed({ type: 'image.sourceChanged', ids: [iid] });
        message = sourceEdit.manual ? (src ? '已确认来源' : '已清除来源') : '已恢复自动来源';
      }
      if (body.kind !== undefined) {
        const value = body.kind;
        setKindInTx(this.ctx, u, [iid], value, this.kindDeps);
        message = value === 'auto' ? '已恢复自动判断' : `已标为「${KIND_LABEL[value]}」`;
      }
      if (charIds) {
        // 整组替换：去掉的记否决、Pixiv 补充不再采纳旧建议；新的手动加上（清掉否决，D3）；本来就有的保持原来的来历。
        // 新角色命中「角色」排除规则时由反应排除（附录 #14）
        replaceCharacters(this.ctx, u, iid, charIds, manual(now));
        message = '已更新角色';
      }
      // 手动改分级要记下来：T10 重打标签时不覆盖
      if (body.rating) {
        setRating(this.ctx, u, [iid], body.rating);
        message = '已修改分级';
      }
      if (body.favorite !== undefined) {
        setFavorite(this.ctx, u, [iid], body.favorite);
        message = body.favorite ? '已收藏' : '已取消收藏';
      }
      return { message: message || '已更新' };
    });
  }
  /** 读图片文件用的行；不要求「可见」（排除页、已处理的重复组也要显示被排除或已删除图片的缩略图） */
  private fileRow(id: ID): ImageFileRow | null {
    const n = parseId(id);
    if (n === null) return null;
    return (
      (this.ctx
        .stmt(
          `SELECT i.id, i.sha256, i.format, i.width, i.height, i.file_name, i.rel_path, i.dominant_color, r.path AS root_path
           FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?`,
        )
        .get(n) as ImageFileRow | undefined) ?? null
    );
  }

  async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
    const row = this.fileRow(id);
    if (!row) return null;
    if (this.ports.imageFiles) return this.ports.imageFiles.thumbnail(row, width);
    const file = await this.thumbs.ensure(row, width);
    if (!file) return null;
    // 图片 id 稳定（内容变了 id 不变），所以不能用 immutable，按内容 sha 做 ETag
    return {
      kind: 'path',
      contentType: 'image/webp',
      filePath: file,
      etag: `"${row.sha256.slice(0, 20)}-${width}"`,
      cacheControl: 'private, no-cache',
    };
  }

  /** 不要求可见；文件不在了返回 null → 404 */
  async getOriginal(id: ID): Promise<FileResponse | null> {
    const row = this.fileRow(id);
    if (!row) return null;
    if (this.ports.imageFiles) return this.ports.imageFiles.original(row);
    const abs = toAbs(row.root_path, row.rel_path);
    try {
      await access(abs);
    } catch {
      return null;
    }
    const html = row.format === 'html' ? await readHtmlAnimation(abs) : null;
    const sha = html ? sha256Buffer(html) : row.sha256;
    const filePath = html ? await htmlAnimationCache(html,this.ctx.dataDir,sha) : abs;
    return { kind: 'path', contentType: MIME[row.format], filePath, etag: `"${sha.slice(0, 20)}"`, cacheControl: 'private, no-cache' };
  }

  async revealImage(id: ID): Promise<void> {
    const n = this.requireVisibleImages([id])[0]!;
    this.requireLibraryFiles('在资源管理器中显示文件');
    const row = this.ctx
      .stmt('SELECT i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as { rel_path: string; root_path: string };
    const abs = toAbs(row.root_path, row.rel_path);
    try {
      await access(abs);
    } catch {
      throw new NotFoundError('文件（可能已被移动或删除）');
    }
    await revealInFileManager(abs);
  }

  // T18 批量操作 / 回收站
  async bulkImages(body: BulkImagesBody): Promise<MutationResult> {
    // 画师改回自动后马上重新认这几张：由反应 queueArtists 做（撤销手动改画师时也一样）
    return this.bulk.run(body);
  }

  /** 移动要处理的图：按角色时是这个角色现在可见的图，否则是给的 ids */
  private moveRows(body: MoveImagesBody) {
    const root = this.requireRoot(body.rootId);
    if (!root.enabled) throw new BadRequestError('这个图库文件夹停用了，先启用再移动');
    const dir = normalizeSubdir(body.dir);
    const cols = `i.id, i.root_id, i.rel_path, i.file_name, CASE WHEN EXISTS (SELECT 1 FROM collections c WHERE c.id = i.collection_id AND c.membership = 'folder') THEN i.collection_id ELSE NULL END AS collection_id, i.tagged_at, i.retag, ${IN_COMIC('i')} AS in_comic, r.path AS root_path`;
    let rows: (MoveRow & { tagged_at: string | null; retag: number; in_comic: number })[];
    if (body.characterId !== undefined && body.ids === undefined) {
      const c = this.requireCharacterId(body.characterId);
      rows = this.ctx
        .stmt(
          `SELECT ${cols} FROM v_counted_images i JOIN library_roots r ON r.id = i.root_id
           WHERE EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = ?) ORDER BY i.id`,
        )
        .all(c) as typeof rows;
    } else {
      const ids = this.requireVisibleImages(body.ids ?? []);
      rows = this.ctx
        .stmt(`SELECT ${cols} FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id IN (SELECT value FROM json_each(?)) ORDER BY i.id`)
        .all(JSON.stringify(ids)) as typeof rows;
    }
    return { root, dir, rows };
  }

  /** 移动前先数（对话框显示的就是服务端会移的） */
  async previewMove(body: MoveImagesBody): Promise<MovePreview> {
    const { root, dir, rows } = this.moveRows(body);
    let alreadyThere = 0;
    let inCollection = 0;
    const ids: number[] = [];
    for (const r of rows) {
      if (r.collection_id !== null) inCollection++;
      else if (r.root_id === root.id && parentRel(r.rel_path).toLowerCase() === dir.toLowerCase()) alreadyThere++;
      else ids.push(r.id);
    }
    const cid = body.characterId === undefined ? null : this.requireCharacterId(body.characterId);
    const json = JSON.stringify(ids);
    const otherCharacters = (
      cid === null
        ? this.ctx.db.prepare('SELECT COUNT(*) FROM (SELECT image_id FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) GROUP BY image_id HAVING COUNT(*) > 1)').pluck().get(json)
        : this.ctx.db.prepare('SELECT COUNT(DISTINCT image_id) FROM image_characters WHERE image_id IN (SELECT value FROM json_each(?)) AND character_id <> ?').pluck().get(json, cid)
    ) as number;
    return { ids: ids.map(toId), alreadyThere, inCollection, otherCharacters };
  }

  async moveImages(body: MoveImagesBody): Promise<MutationResult> {
    const { root, dir, rows } = this.moveRows(body);
    this.requireLibraryFiles('移动文件');
    if (!rows.length) throw new BadRequestError('没有可以移动的图');

    // 扫描、识别正在读这些文件时不能移（扫描会把移走的图当成丢失）
    const running = (await this.ctx.jobs.list()).filter((j) => j.status === 'running').map((j) => j.kind);
    if (running.includes('scan')) throw new ConflictError('正在扫描图库，等扫描结束再移动');
    if (running.includes('tag') && rows.some((r) => !r.in_comic && (r.tagged_at === null || r.retag))) {
      throw new ConflictError('正在识别，选中的图里有还没识别完的，等识别结束再移动');
    }

    const dest = { rootId: root.id, rootPath: root.path, dir };
    const out = moveImageFiles(this.ctx.db, rows, dest);
    const ids = out.moved.map((m) => m.id);
    // 移进漫画文件夹会清掉识别器认的角色、移出会标重新识别：撤销时放回去
    const json = JSON.stringify(ids);
    // 漫画区同步只去掉自动关联（附录 #6）：快照也只记自动的，移回时按原来的来历放回
    const charSnap = this.ctx.db.prepare("SELECT * FROM image_characters WHERE decision = 'auto' AND image_id IN (SELECT value FROM json_each(?))").all(json);
    const retagSnap = this.ctx.db.prepare('SELECT id, retag FROM images WHERE id IN (SELECT value FROM json_each(?))').all(json);
    // 和扫描发现的移动、整理到子文件夹一样：来源、路径相关的分类（漫画文件夹）、排除规则、合集都由反应按新位置重算（附录 #11、#17）
    if (ids.length) this.ctx.apply(() => this.ctx.changed({ type: 'image.moved', ids, reason: 'move' }));

    const where = dir ? toAbs(root.path, dir).replace(/\\/g, '/') : root.path;
    const notes = [
      out.alreadyThere && `${out.alreadyThere} 张本来就在这里`,
      out.inCollection && `合集里的 ${out.inCollection} 张没动`,
      out.failed.length && `${out.failed.length} 张移动失败：${out.failed.slice(0, 3).join('、')}${out.failed.length > 3 ? ' 等' : ''}`,
    ].filter(Boolean);
    const message = `已移动 ${out.moved.length} 张到 ${where}${notes.length ? `（${notes.join('；')}）` : ''}`;
    if (!out.moved.length) {
      if (out.failed.length) throw new ConflictError(message);
      return done(message);
    }
    // 记进库里：重启后也能在「最近的移动」里移回原处
    const payload: MovePayload = { where, items: out.moved, charSnap: charSnap as MovePayload['charSnap'], retagSnap: retagSnap as MovePayload['retagSnap'] };
    const logId = recordChange(this.ctx, 'move', `${out.moved.length} 张移到 ${where}`, payload);
    const result = this.ctx.undo.result(message, async () => {
      await this.changes.revertMove(logId, true);
    });
    this.changes.rememberMoveToken(logId, result.undoToken!);
    return result;
  }

  // 最近的改动（自动关联、Pixiv 补充、移动到文件夹）
  async listChanges(group: ChangeGroup): Promise<ChangeEntry[]> {
    return this.changes.list(group);
  }
  async revertChange(id: ID): Promise<MutationResult> {
    // 移回原处要动文件
    if (this.ctx.stmt('SELECT kind FROM change_log WHERE id = ?').pluck().get(parseId(id)) === 'move') this.requireLibraryFiles('移回文件');
    return this.changes.revert(id);
  }

  // T15 未识别
  async listUnrecognized(query: ListUnrecognizedQuery): Promise<ListUnrecognizedResponse> {
    return this.unrecognized.list(query);
  }

  async unrecognizedSummary(query: UnrecognizedSummaryQuery = {}): Promise<UnrecognizedSummary> {
    return this.unrecognized.summary(query.artKind);
  }
  async acceptSuggestion(imageId: ID, danbooruTag: string): Promise<MutationResult> {
    return this.unrecognized.accept(imageId, danbooruTag);
  }
  async acceptSuggestions(imageId: ID, danbooruTags: string[]): Promise<MutationResult> {
    return this.unrecognized.acceptMany(imageId, danbooruTags);
  }
  async retagUnrecognized(): Promise<RetagResult> {
    this.unrecognized.markRetag();
    // 之前标过、还没跑完的也算：只要有等着重新识别的，就启动识别任务
    const pending = this.ctx.stmt(`SELECT COUNT(*) AS n FROM images i WHERE i.retag = 1 AND NOT ${IN_COMIC('i')}`).get() as { n: number };
    return { marked: pending.n, job: pending.n ? await this.startJob('tag') : null };
  }

  // T16 查重
  async listDuplicates(query: ListDuplicatesQuery): Promise<DuplicateGroup[]> {
    return this.results.get(`dups:${query.resolved ? 1 : 0}`, () => this.duplicates.list(query)) as DuplicateGroup[];
  }
  async resolveDuplicate(id: ID, keepIds: ID[], batch?: string): Promise<MutationResult> {
    return this.duplicates.resolve(id, keepIds, batch);
  }
  async ignoreDuplicate(id: ID): Promise<MutationResult> {
    return this.duplicates.ignore(id);
  }

  // T17 排除
  async listExclusions(): Promise<Exclusion[]> {
    return this.exclusions.list();
  }
  async createExclusion(body: CreateExclusionBody): Promise<MutationResult> {
    return this.exclusions.create(body.kind, body.target);
  }
  async deleteExclusion(id: ID): Promise<MutationResult> {
    return this.exclusions.delete(id);
  }

  // T20 搜索
  async tagSuggestions(query: TagSuggestionsQuery): Promise<TagSuggestion[]> {
    return this.searchQueries.tagSuggestions(query);
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    return this.searchQueries.search(query, query.forAssignment ? this.makeCatalog().catalog : undefined);
  }

  // T02 设置 / 图库文件夹
  private readonly settingsListeners = new Set<(s: Settings) => void>();
  private readonly rootsListeners = new Set<() => void>();

  /** 设置变了（T09 / T10 / T11 用来重载配置） */
  onSettingsChanged(fn: (s: Settings) => void): () => void {
    this.settingsListeners.add(fn);
    return () => this.settingsListeners.delete(fn);
  }

  /** 图库文件夹增删启停（T08 据此调整监听） */
  onRootsChanged(fn: () => void): () => void {
    this.rootsListeners.add(fn);
    return () => this.rootsListeners.delete(fn);
  }

  /**
   * 启动时真正删除移除超过 30 天的文件夹（级联删除它的图）和指向已删除图片的单张排除规则。
   * 30 天内的留着：重新添加同一个文件夹时角色、收藏、分级等整理结果都能找回
   */
  purgeRemovedRoots(): void {
    const db = this.ctx.db;
    const cutoff = iso(this.ctx.clock() - REMOVED_ROOT_KEEP_DAYS * 86_400_000);
    db.transaction(() => {
      // A cross-folder selection outlives removal of its original anchor root.
      db.prepare(`UPDATE collections SET root_id = (SELECT i.root_id FROM images i JOIN library_roots r ON r.id = i.root_id
          WHERE i.collection_id = collections.id AND r.removed_at IS NULL ORDER BY i.id LIMIT 1)
        WHERE membership <> 'folder' AND root_id IN (SELECT id FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?)
          AND EXISTS (SELECT 1 FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.collection_id = collections.id AND r.removed_at IS NULL)`).run(cutoff);
      const roots = db.prepare('DELETE FROM library_roots WHERE removed_at IS NOT NULL AND removed_at < ?').run(cutoff).changes;
      const ex = db
        .prepare("DELETE FROM exclusions WHERE kind = 'image' AND CAST(target AS INTEGER) NOT IN (SELECT id FROM images)")
        .run().changes;
      if (roots || ex) console.log(`已清理移除的文件夹 ${roots} 个、失效的单张排除 ${ex} 条`);
    })();
  }

  async getSettings(): Promise<Settings> {
    const rows = this.ctx
      .stmt(
        `SELECT r.id, r.path, r.enabled, r.last_scan_at, r.imported_at, r.content_mode, r.comic_rating,
           (SELECT COUNT(*) FROM images i
             WHERE i.root_id = r.id AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL) AS image_count
         FROM library_roots r
         WHERE r.removed_at IS NULL
         ORDER BY r.id`,
      )
      .all() as {
      id: number;
      path: string;
      enabled: number;
      last_scan_at: string | null;
      imported_at: string | null;
      content_mode: string;
      comic_rating: string;
      image_count: number;
    }[];
    const folders = this.ctx.db.prepare('SELECT root_id, rel_dir, comic_rating FROM comic_folders ORDER BY rel_dir').all() as {
      root_id: number;
      rel_dir: string;
      comic_rating: Rating;
    }[];
    return {
      libraryRoots: rows.map((r) => ({
        id: toId(r.id),
        path: r.path,
        enabled: !!r.enabled,
        imageCount: r.image_count,
        lastScanAt: r.last_scan_at,
        importedAt: r.imported_at,
        mode: r.content_mode === 'comic' ? 'comic' : 'auto',
        comicRating: r.comic_rating as Rating,
        comicFolders: folders.filter((f) => f.root_id === r.id).map((f) => ({ relDir: f.rel_dir, comicRating: f.comic_rating })),
      })),
      ...readSettings(this.ctx.db),
    };
  }

  /** 切换 Pixiv 投稿号识别方式前先数：多少张来源会变、多少张先去掉 Pixiv 建议、多少张要重新补（有缓存的不联网） */
  async previewSourceMode(mode: 'strict' | 'broad'): Promise<SourceModePreview> {
    const changes = diffSources(this.ctx.db, mode);
    const requeue = changes.filter((c) => c.newPixivPost !== null);
    const cached = new Set(
      this.ctx.db.prepare('SELECT post_id FROM pixiv_artwork_cache WHERE post_id IN (SELECT value FROM json_each(?))').pluck()
        .all(JSON.stringify([...new Set(requeue.map((c) => c.newPixivPost))])) as string[],
    );
    const hasPixivSug = this.ctx.db.prepare("SELECT 1 FROM character_suggestions WHERE image_id = ? AND source = 'pixiv' LIMIT 1");
    return {
      mode,
      changed: changes.length,
      suggestionsDropped: changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged && hasPixivSug.get(c.id)).length,
      requeued: requeue.length,
      cached: requeue.filter((c) => cached.has(c.newPixivPost!)).length,
    };
  }

  /**
   * 有缓存的投稿马上在本地重新匹配（不联网）；返回找回了 Pixiv 建议或关联的张数。
   * 来源变了之后由反应 rematchCachedPixiv 调用（改识别方式、手动改来源，以及撤销它们，附录 #22）
   */
  private async rematchCachedPixiv(ids: number[]): Promise<number> {
    if (!ids.length || !this.makeCatalog) return 0;
    const cachedIds = this.ctx.db
      .prepare(
        `SELECT i.id FROM images i JOIN pixiv_character_checks p ON p.image_id = i.id AND p.checked_at IS NULL
         WHERE i.id IN (SELECT value FROM json_each(?)) AND i.source_post_id IN (SELECT post_id FROM pixiv_artwork_cache)`,
      )
      .pluck()
      .all(JSON.stringify(ids)) as number[];
    if (!cachedIds.length) return 0;
    const controller = new AbortController();
    const job: JobContext = {
      signal: controller.signal,
      setTotal: () => {},
      advance: () => {},
      setMessage: () => {},
      shouldYield: () => false,
      requeue: () => {},
      yielded: false,
    };
    // 只挑有缓存的图，client 不会被调用；万一调用了也不联网
    const offline = { artwork: async () => { throw new Error('离线重新匹配不联网'); } };
    try {
      await syncPixivCharacters(this.ctx, job, this.makeCatalog, offline, 0, undefined, { imageIds: cachedIds });
    } catch (error) {
      console.warn(`[pixiv-tags] 切换识别方式后本地重新匹配失败：${String(error)}`);
      return 0;
    }
    return this.ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) FROM images i WHERE i.id IN (SELECT value FROM json_each(?)) AND (
           EXISTS (SELECT 1 FROM character_suggestions cs WHERE cs.image_id = i.id AND cs.source = 'pixiv')
           OR EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id))`,
      )
      .pluck()
      .get(JSON.stringify(cachedIds)) as number;
  }

  /**
   * 切换 Pixiv 投稿号识别方式（设置 → 识别）：报告影响了多少张，可撤销（来源、Pixiv 建议、补充记录、设置一起回去）。
   * 投稿号真的变了的才去掉 Pixiv 建议；切回原来的投稿号时有缓存的马上找回，没缓存的等补充 Pixiv 角色
   */
  async setSourceMode(mode: 'strict' | 'broad'): Promise<MutationResult> {
    const db = this.ctx.db;
    const before = readSettings(db).tagger.pixivFilenameMode;
    const label = mode === 'broad' ? '宽泛' : '严格';
    if (mode === before) return done(`已经是${label}了`);
    let requeued: number[] = [];
    let changed = 0;
    let dropped = 0;
    const result = this.ctx.mutate((u) => {
      const changes = diffSources(db, mode);
      changed = changes.length;
      const ids = JSON.stringify(changes.map((c) => c.id));
      u.columns('images', ['source_site', 'source_post_id', 'source_artist', 'source_url'], changes.map((c) => c.id));
      u.set('character_suggestions', "source = 'pixiv' AND image_id IN (SELECT value FROM json_each(?))", [ids]);
      u.set('pixiv_character_checks', 'image_id IN (SELECT value FROM json_each(?))', [ids]);
      // 设置只改回这一项，期间改的其他设置不动
      u.sql("UPDATE settings SET value = json_set(value, '$.pixivFilenameMode', ?) WHERE key = 'tagger'", [before]);
      u.sql("INSERT INTO settings (key, value) VALUES ('sourceParserMode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(before)]);
      dropped = db.prepare("SELECT COUNT(DISTINCT image_id) FROM character_suggestions WHERE source = 'pixiv' AND image_id IN (SELECT value FROM json_each(?))").pluck().get(
        JSON.stringify(changes.filter((c) => c.before.site === 'pixiv' && c.pixivPostChanged).map((c) => c.id)),
      ) as number;
      applySettingsPatch(db, { tagger: { pixivFilenameMode: mode } });
      applySourceChanges(db, changes);
      markSourcesCurrent(db, mode);
      requeued = changes.filter((c) => c.newPixivPost !== null).map((c) => c.id);
      // 清过期的 Pixiv 建议、重新登记补充、刷新同投稿组、有缓存的马上在本地重新匹配，都由反应做；撤销时重放，同样重跑（附录 #13、#22）
      this.ctx.changed({ type: 'image.sourceChanged', ids: changes.map((c) => c.id) });
      this.ctx.changed({ type: 'settings.changed', sections: ['tagger'], ids: [] });
      return { message: `已改为${label}：${changed} 张图的来源变了` };
    });
    await this.ctx.propagation.idle();
    const found = this.pixivFound(requeued);
    const left = requeued.length - found;
    const notes = [
      dropped && `${dropped} 张的 Pixiv 建议先去掉了（投稿号变了，切回来能找回）`,
      found && `${found} 张从缓存找回了 Pixiv 角色`,
      left > 0 && `${left} 张等「补充 Pixiv 角色」时再查`,
    ].filter(Boolean);
    if (left > 0) this.pipeline.requestPixiv();
    return { ...result, message: `${result.message}${notes.length ? `；${notes.join('，')}` : ''}` };
  }

  /** 这些图里有 Pixiv 建议或角色关联的张数（切换识别方式后的提示） */
  private pixivFound(ids: number[]): number {
    if (!ids.length) return 0;
    return this.ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) FROM images i
         JOIN pixiv_character_checks p ON p.image_id = i.id AND p.checked_at IS NOT NULL AND p.post_id = i.source_post_id
         WHERE i.id IN (SELECT value FROM json_each(?)) AND (
           EXISTS (SELECT 1 FROM character_suggestions cs WHERE cs.image_id = i.id AND cs.source = 'pixiv')
           OR EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id))`,
      )
      .pluck()
      .get(JSON.stringify(ids)) as number;
  }

  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    const beforeArtists = readSettings(this.ctx.db).tagger.artists;
    const beforePixiv = readSettings(this.ctx.db).tagger.pixiv;
    const beforeMode = readSettings(this.ctx.db).tagger.pixivFilenameMode;
    const { pixivFilenameMode, ...taggerRest } = body.tagger ?? {};
    // 换识别方式走 setSourceMode（报告影响、可撤销），其余照常保存
    // 设置监听者（识别、Danbooru 等重载配置）和缓存由反应通知（settings.changed）
    this.ctx.apply(() => {
      applySettingsPatch(this.ctx.db, { ...body, ...(body.tagger && { tagger: taggerRest }) } as Parameters<typeof applySettingsPatch>[1]);
      this.ctx.changed({ type: 'settings.changed', sections: Object.keys(body), ids: [] });
    });
    if (pixivFilenameMode !== undefined && pixivFilenameMode !== beforeMode) await this.setSourceMode(pixivFilenameMode);
    const settings = await this.getSettings();
    // 调低自动采纳阈值不在保存时动已有建议：设置页显示有多少达标，用户点按钮才归（promoteSuggestions，可撤销）
    // 刚打开「识别画师」：给已识别的图补跑（任务在显卡道里排在识别后面，可以随时取消）
    if (body.tagger?.artists === true && !beforeArtists) {
      this.pipeline.noteManualStart('artists');
      this.ctx.jobs.enqueue('artists');
    }
    // 关掉：正在跑和排队中的补跑一起停（关了开关，设置页的进度和取消按钮也没了）
    if (body.tagger?.artists === false && beforeArtists) {
      for (const j of this.ctx.jobs.list()) if (j.kind === 'artists' && (j.status === 'queued' || j.status === 'running')) this.ctx.jobs.cancel(j.id);
    }
    // 刚打开自动查 Pixiv：把关着时登记下来的图补上
    if (body.tagger?.pixiv === true && !beforePixiv) this.pipeline.requestPixiv();
    // 关掉：停掉自动排上的（排队中和正在跑的）；用户在「未识别」页手动点的照常跑完
    if (body.tagger?.pixiv === false && beforePixiv && !this.pipeline.isPixivManual()) {
      for (const j of this.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && (j.status === 'queued' || j.status === 'running')) this.ctx.jobs.cancel(j.id);
    }
    return settings;
  }

  /** 按当前阈值和角色目录计算可补采纳的建议 */
  async promotableSuggestions(kind?: ContentKind): Promise<PromotableSuggestions> {
    const threshold = readSettings(this.ctx.db).tagger.autoAcceptThreshold;
    return { ...countPromotable(this.ctx, this.kindDeps, kind), threshold };
  }

  /** 用户点按钮：把达标的建议归到角色，可撤销 */
  async promoteSuggestions(kind?: ContentKind): Promise<MutationResult> {
    return this.ctx.mutate((u) => {
      const ids = promoteSuggestions(this.ctx, u, null, this.kindDeps, kind);
      return { message: ids.length ? `已把 ${ids.length} 张图按达标的建议归到角色` : '没有达标的建议了' };
    });
  }

  private requireRoot(id: ID): { id: number; path: string; enabled: number } {
    const n = parseId(id);
    const row =
      n === null
        ? undefined
        : (this.ctx.stmt('SELECT id, path, enabled FROM library_roots WHERE id = ? AND removed_at IS NULL').get(n) as
            | { id: number; path: string; enabled: number }
            | undefined);
    if (!row) throw new NotFoundError('图库文件夹');
    return row;
  }

  async addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult> {
    this.requireLibraryFiles('添加图库文件夹');
    const input = normalizeRootPath(body.path);
    try {
      const st = await stat(input);
      if (!st.isDirectory()) throw new BadRequestError('这不是一个文件夹');
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new BadRequestError('没有权限读取这个文件夹');
      throw new BadRequestError(`找不到这个文件夹：${input}`);
    }
    // 同一个文件夹换种写法（联接点、subst 盘、\\?\ 前缀、映射盘和 UNC 路径）也要认出来：下面的判断都按真实位置比较。
    // 存的还是用户选的写法，只有 \\?\、\\.\ 开头的换成普通路径
    const pk = await rootPathKey(input);
    const p = /^\/\/[?.]\//.test(input) ? pk : input;

    const db = this.ctx.db;
    const mode = body.mode === 'comic' ? 'comic' : 'auto';
    const comicRating = body.comicRating ?? 'general';
    const rawRows = db.prepare('SELECT id, path, enabled, removed_at, imported_at, content_mode FROM library_roots').all() as (ChildRoot & {
      enabled: number;
      content_mode: string;
    })[];
    const rows = await Promise.all(rawRows.map(async (r) => ({ ...r, key: await rootPathKey(r.path) })));
    const active = rows.filter((r) => r.removed_at === null);
    if (active.some((r) => samePath(r.key, pk))) throw new BadRequestError('这个文件夹已经在图库里了');
    const parent = active.find((r) => isInside(pk, r.key));
    // 已有图库文件夹里面的子文件夹：选了漫画就把这个子文件夹按漫画导入，不另加图库文件夹
    if (parent && mode === 'comic') return this.setComicFolder(parent, await diskCaseRel(parent.path, relUnder(parent.key, pk)), comicRating);
    if (parent) throw new BadRequestError(`已经包含在「${parent.path}」里了，不用单独添加。要把它当漫画，选「漫画 · 跳过识别」再添加`);
    const d = await rootPathKey(normalizeRootPath(this.ctx.dataDir));
    if (samePath(pk, d) || isInside(pk, d) || isInside(d, pk)) throw new BadRequestError('不能把 Emaki 的数据目录加入图库');

    // 新文件夹包含已有的文件夹：问一下再合并。以前移除过的子文件夹直接接管，找回当时的整理结果
    const children = rows.filter((r) => isInside(r.key, pk));
    const activeChildren = children.filter((r) => r.removed_at === null);
    if (activeChildren.length && !body.merge) {
      const names = activeChildren.map((r) => `「${r.path}」`).join('');
      const disabled = activeChildren.filter((r) => !r.enabled).map((r) => `「${r.path}」`);
      const comics = activeChildren.filter((r) => r.content_mode === 'comic').map((r) => `「${r.path}」`);
      throw new NeedsConfirmError(
        `这个文件夹包含图库里已有的${names}，合并成一个吗？${mode === 'comic' ? '原来的整理结果都会保留；按漫画导入后，里面识别器认出的角色会去掉（手动加的留着），以后改回插画会重新识别。' : '原来的识别和整理结果都会保留。'}` +
          (disabled.length ? `其中${disabled.join('')}现在是停用的，合并后会重新显示。` : '') +
          (comics.length && mode !== 'comic' ? `${comics.join('')}按漫画导入的设置会保留（变成里面的漫画子文件夹）。` : ''),
      );
    }
    // 合并前照例备份（VACUUM INTO 不能在事务里，目标文件已存在会报错）
    if (activeChildren.length) {
      const backup = path.join(this.ctx.dataDir, 'emaki.before-merge.bak.sqlite');
      await rm(backup, { force: true });
      db.exec(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
    }

    const removed = rows.find((r) => r.removed_at !== null && samePath(r.key, pk));
    // 在移除过的父文件夹里面添加：接管父文件夹在这里面的旧记录，由内往外
    const removedParents = await Promise.all(
      rows
        .filter((r) => r.removed_at !== null && isInside(pk, r.key))
        .sort((a, b) => b.key.length - a.key.length)
        .map(async (r) => ({ id: r.id, imported_at: r.imported_at, prefix: await diskCaseRel(r.path, relUnder(r.key, pk)) })),
    );
    let rootId = 0;
    let merged = 0;
    let adopted = 0;
    let revived = 0;
    // 文件夹重新显示：合集全量重算、文件监听、查重标记都由反应做
    this.ctx.apply(() => {
      if (removed) {
        // 复活：旧图和识别结果全部回来
        db.prepare('UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(
          p,
          mode,
          comicRating,
          removed.id,
        );
        rootId = removed.id;
        revived = db.prepare('SELECT COUNT(*) FROM images WHERE root_id = ?').pluck().get(rootId) as number;
      } else {
        rootId = Number(
          db.prepare('INSERT INTO library_roots (path, enabled, content_mode, comic_rating) VALUES (?, 1, ?, ?)').run(p, mode, comicRating).lastInsertRowid,
        );
      }
      // 子文件夹在新文件夹下的相对路径按真实位置算（两边可能是不同写法）
      if (children.length) merged = mergeChildRoots(db, rootId, pk, children.map((c) => ({ ...c, path: c.key }))).images;
      if (removedParents.length) adopted = adoptFromRemovedParents(db, rootId, removedParents).images;
      // 合并、接管进来的旧图换了文件夹（路径变了）；复活、合并、接管进来的旧图按这次的设置重判类型（按漫画导入：归漫画、用选的分级）
      const ids = removed || children.length || adopted ? this.imagesUnder(rootId) : [];
      if (children.length || adopted) this.ctx.changed({ type: 'image.moved', ids, reason: 'root' });
      this.ctx.changed({ type: 'root.visibilityChanged', rootIds: [rootId], ids });
      this.ctx.changed({ type: 'root.modeChanged', rootIds: [rootId], ids });
    });
    // 这些旧图隐藏期间跑过的查重会把它们的未处理重复组删掉：这次扫描完（哪怕没有新图）再查一次（反应已经标了「要查重」）
    // 只扫新文件夹（扫描正在跑时也再排一次）：反应 rescanRoots 对重新显示的文件夹做
    // 复活的、接管的、并进来的移除过的子文件夹，都算找回
    const back = revived + adopted + merged;
    const found = back ? `（找回了 ${back} 张图以前的整理结果）` : '';
    return done(
      activeChildren.length
        ? `已合并成一个文件夹（保留了 ${back} 张图的整理结果），开始扫描其余部分：${p}`
        : mode === 'comic'
          ? `已按漫画导入${found}，开始扫描（不识别，每个子文件夹成一本）：${p}`
          : `已添加文件夹${found}，开始扫描：${p}`,
    );
  }

  /**
   * 这个文件夹（relDir 给了就是里面的子文件夹）的漫画设置变了：声明 root.modeChanged，反应按新设置重判类型、分级、去掉识别器的角色，
   * 合集全量重算，监听者、识别排队跟着走。先记下会动的识别器角色和重新识别标记（撤销用）
   */
  private rootModeChanged(rootId: number, relDir: string | undefined, u: UndoRecorder): void {
    const ids = this.imagesUnder(rootId, relDir);
    recordRootModeUndo(u, ids);
    this.ctx.changed({ type: 'root.modeChanged', rootIds: [rootId], ids });
  }

  /**
   * 撤销切换导入方式时，文件夹设置、识别器角色都还原之后，按快照写回类型和分级（restoreRootImages）。
   * 撤销逆序执行，所以要在 mutate 里最先记录
   */
  private restoreRootImagesOnUndo(u: UndoRecorder, rootId: number, snap: RootImageSnap[], relDir?: string): void {
    if (snap.length) u.custom(() => this.restoreRootImages(rootId, snap, relDir));
  }

  /** 图库文件夹里（relDir 给了就是这个子文件夹里）的全部图 */
  private imagesUnder(rootId: number, relDir?: string): number[] {
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    return this.ctx.db.prepare(`SELECT id FROM images WHERE root_id = @root ${under}`).pluck().all({ root: rootId, dir: relDir ?? '' }) as number[];
  }

  /**
   * 图库文件夹里的子文件夹按漫画导入（rating = null：不再按漫画导入）；可撤销。
   * 里面的图按新设置重判类型和分级、合集重算、不再按漫画导入时没识别过的图接着识别，都由反应做（撤销时同样）
   */
  private setComicFolder(root: { id: number; path: string }, rawDir: string, rating: Rating | null): MutationResult {
    const db = this.ctx.db;
    const relDir = rawDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!relDir) throw new BadRequestError('要选图库文件夹里面的子文件夹');
    const cur = db.prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?').get(root.id, relDir) as { comic_rating: Rating } | undefined;
    if (rating === null && !cur) throw new NotFoundError('按漫画导入的子文件夹');
    if (rating !== null) {
      const area = ComicAreas.load(db).of(root.id, relDir);
      if (area && area.relDir !== relDir) throw new BadRequestError(`已经在按漫画导入的「${area.path}」里了`);
      if (cur?.comic_rating === rating) return done('没有变化');
    }
    const snap = db
      .prepare(`SELECT id, tagged_at, ${ROOT_MODE_COLS.join(', ')} FROM images WHERE root_id = @root AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'`)
      .all({ root: root.id, dir: relDir }) as RootImageSnap[];
    const where = `${root.path.replace(/\/+$/, '')}/${relDir}`;
    return this.ctx.mutate((u) => {
      this.restoreRootImagesOnUndo(u, root.id, snap, relDir);
      u.set('comic_folders', 'root_id = ? AND rel_dir = ?', [root.id, relDir]);
      if (rating === null) db.prepare('DELETE FROM comic_folders WHERE root_id = ? AND rel_dir = ?').run(root.id, relDir);
      else
        db.prepare(
          'INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(root_id, rel_dir) DO UPDATE SET comic_rating = excluded.comic_rating',
        ).run(root.id, relDir, rating, iso(this.ctx.clock()));
      this.rootModeChanged(root.id, relDir, u);
      const message =
        rating === null
          ? `「${where}」不再按漫画导入：没识别过的图会开始识别`
          : cur
            ? `「${where}」的分级改成了「${RATING_LABEL[rating]}」`
            : `已把「${where}」按漫画导入：${snap.length} 张归到漫画，不再识别`;
      return { message };
    });
  }

  async updateLibraryRoot(id: ID, body: UpdateLibraryRootBody): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const db = this.ctx.db;
    // 里面的漫画子文件夹：单独一步（各自可以撤销）
    if (body.comicFolder) {
      const cur = db.prepare('SELECT comic_rating FROM comic_folders WHERE root_id = ? AND rel_dir = ?').pluck().get(root.id, body.comicFolder.relDir) as Rating | undefined;
      return this.setComicFolder(root, body.comicFolder.relDir, body.comicFolder.comicRating ?? cur ?? 'general');
    }
    if (body.removeComicFolder !== undefined) return this.setComicFolder(root, body.removeComicFolder, null);
    const cur = db.prepare('SELECT enabled, content_mode, comic_rating FROM library_roots WHERE id = ?').get(root.id) as {
      enabled: number;
      content_mode: string;
      comic_rating: string;
    };
    const enabled = body.enabled === undefined ? cur.enabled : body.enabled ? 1 : 0;
    const mode = body.mode ?? (cur.content_mode === 'comic' ? 'comic' : 'auto');
    const rating = body.comicRating ?? cur.comic_rating;
    const modeChanged = mode !== cur.content_mode;
    const ratingChanged = rating !== cur.comic_rating;
    const cols = [enabled !== cur.enabled && 'enabled', modeChanged && 'content_mode', ratingChanged && 'comic_rating'].filter(
      (c): c is string => !!c,
    );
    if (!cols.length) return done('没有变化');
    const touchesImages = modeChanged || (ratingChanged && mode === 'comic');
    // 撤销用：改之前这个文件夹里每张图的类型、分级（连同当时的识别时间，见 restoreRootImages）
    const snap = touchesImages
      ? (db.prepare(`SELECT id, tagged_at, ${ROOT_MODE_COLS.join(', ')} FROM images WHERE root_id = ?`).all(root.id) as RootImageSnap[])
      : [];
    // 合集全量重算（提交后）、文件监听、重新启用后的整根扫描和查重、改回插画后的识别，都由反应做；撤销时重放同样的变化
    return this.ctx.mutate((u) => {
      this.restoreRootImagesOnUndo(u, root.id, snap);
      u.columns('library_roots', cols, [root.id]);
      db.prepare('UPDATE library_roots SET enabled = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(enabled, mode, rating, root.id);
      if (enabled !== cur.enabled) this.ctx.changed({ type: 'root.visibilityChanged', rootIds: [root.id], ids: [] });
      if (touchesImages) this.rootModeChanged(root.id, undefined, u);
      const message =
        enabled !== cur.enabled
          ? enabled
            ? `已启用：${root.path}`
            : `已停用：${root.path}`
          : modeChanged
            ? mode === 'comic'
              ? `已改成按漫画导入：${snap.length} 张归到漫画，不再识别`
              : `已改回按插画识别：没识别过的图会开始识别`
            : `按漫画导入的分级改成了「${RATING_LABEL[rating as Rating]}」`;
      return { message };
    });
  }

  /**
   * 撤销切换导入方式时恢复这个文件夹的图：期间没重新识别过的行按快照写回（手动改过的类型、分级不动）；
   * 期间识别过的、新扫进来的行按现在（已经恢复）的设置重判，免得把新的识别结果盖回旧值。在撤销事务里执行
   */
  private restoreRootImages(rootId: number, snap: RootImageSnap[], relDir?: string): void {
    const db = this.ctx.db;
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    const now = new Map(
      (
        db.prepare(`SELECT id, tagged_at, content_kind_manual, rating_manual FROM images WHERE root_id = @root ${under}`).all({ root: rootId, dir: relDir ?? '' }) as {
          id: number;
          tagged_at: string | null;
          content_kind_manual: number;
          rating_manual: number;
        }[]
      ).map((r) => [r.id, r]),
    );
    const kindCols = ROOT_MODE_COLS.filter((c) => c !== 'rating');
    const setKind = db.prepare(`UPDATE images SET ${kindCols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`);
    const setRating = db.prepare('UPDATE images SET rating = @rating WHERE id = @id');
    const recompute: number[] = [];
    for (const s of snap) {
      const n = now.get(s.id);
      now.delete(s.id);
      if (!n) continue;
      if (n.tagged_at !== s.tagged_at) {
        recompute.push(s.id);
        continue;
      }
      if (!n.content_kind_manual) setKind.run(s);
      if (!n.rating_manual) setRating.run(s);
    }
    recompute.push(...now.keys());
    // 写回的行也对一遍：不按顺序撤销时（先撤里层的漫画子文件夹，外层的还在），快照里的「插画」已经不对了
    syncRootModes(db, [...recompute, ...snap.map((x) => x.id)], (c) => this.ctx.changed(c));
  }

  /**
   * 停用、移除期间磁盘上的变化监听器收不到，全量扫描也跳过这个文件夹：重新启用（包括撤销停用、撤销移除）时整个扫一遍。
   * 扫描正在跑时也再排一次，别丢了这个请求
   */
  private rescanRoot(rootId: number): void {
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
  }

  async removeLibraryRoot(id: ID): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const set = this.ctx.db.prepare('UPDATE library_roots SET removed_at = ? WHERE id = ?');
    const at = iso(this.ctx.clock());
    // 合集全量重算、文件监听、撤销移除后的整根扫描和查重都由反应做
    const removed = () => this.ctx.changed({ type: 'root.visibilityChanged', rootIds: [root.id], ids: [] });
    this.ctx.apply(() => {
      set.run(at, root.id);
      removed();
    });
    return this.ctx.undo.result(`已移除文件夹：${root.path}。磁盘上的文件没动，${REMOVED_ROOT_KEEP_DAYS} 天内重新添加它能找回整理结果`, () => {
      this.ctx.apply(() => {
        set.run(null, root.id);
        removed();
      });
    });
  }

  // T07 后台任务
  async listJobs(): Promise<Job[]> {
    return this.ctx.jobs.list();
  }
  async startJob(kind: JobKind, options: Pick<StartJobBody, 'refreshPixiv'> = {}): Promise<Job> {
    if (options.refreshPixiv && kind !== 'pixiv-tags') throw new BadRequestError('刷新 Pixiv 标签只用于补充 Pixiv 角色');
    if (kind === 'pixiv-tags') {
      // Repeated starts must not reset checks or invalidate cache during an active run.
      const active = this.ctx.jobs.list().find(j => j.kind === kind && (j.status === 'running' || j.status === 'queued'));
      if (active) return active;
      queuePixivImages(this.ctx);
      if (options.refreshPixiv) clearPendingPixivCache(this.ctx);
      resetPixivBackoff();
    }
    if (kind === 'scan') this.requests.requestFull();
    // 用户手动点的：之前读不到、正在退避的图也马上重试（比如刚把移动硬盘插回去）
    if (kind === 'tag' || kind === 'artists') resetIoBackoff();
    this.pipeline.noteManualStart(kind);
    // 手动扫描时正在跑监听触发的增量扫描：它开始时已经取走了请求，不再排一次的话这次全量扫描就被吞了
    return this.ctx.jobs.enqueue(kind, { requeueIfRunning: kind === 'scan' });
  }
  async cancelJob(id: ID): Promise<void> {
    // 排队中的任务被取消时 runner 不会执行，pipeline 收不到「被取消」：这里先记下暂停，免得识别一结束又排上
    const job = this.ctx.jobs.list().find((j) => j.id === id);
    if (job && (job.status === 'queued' || job.status === 'running')) this.pipeline.notePaused(job.kind);
    this.ctx.jobs.cancel(id);
    // 识别完追加排上的那一轮 Pixiv 也一起取消，不然取消后马上又开始请求 pixiv.net
    if (job?.kind === 'pixiv-tags') for (const j of this.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && j.status === 'queued') this.ctx.jobs.cancel(j.id);
  }

  // 撤销：执行 UndoStack 里记下的反向操作（T19 会加 ctx.mutate，自动记录反向操作）
  async undo(token: string): Promise<MutationResult> {
    return this.ctx.undo.run(token);
  }

  async undoStatus(tokens: string[]): Promise<Record<string, UndoTokenStatus>> {
    return Object.fromEntries(tokens.map((t) => [t, this.ctx.undo.status(t)]));
  }
}
