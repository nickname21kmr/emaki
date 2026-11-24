import type {
  ID,
  Settings,
} from '@emaki/shared';
import { REMOVED_ROOT_KEEP_DAYS } from '@emaki/shared';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { EventBus } from '../../core/events.ts';
import { JobQueue, type JobContext } from '../../core/jobs.ts';
import { done, UndoStack } from '../../core/undo.ts';
import { closeDatabase, openDatabase, type Db } from '../../db/connection.ts';
import { OfflineCharacterIndex } from '../../services/catalog/offlineCharacters.ts';
import { migrate } from '../../db/migrate.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { SoftCache } from './softCache.ts';
import { consolidateCatalog } from '../../domain/catalog/consolidate.ts';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import { ThumbnailService } from '../../services/image/ThumbnailService.ts';
import { Pipeline } from '../../services/pipeline.ts';
import { Scanner } from '../../services/scan/Scanner.ts';
import { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { backfillSources, sourceVersion } from '../../services/source/backfill.ts';
import { ChangeLog } from './changeLog.ts';
import { classifyStale } from '../../domain/analysis/analyze.ts';
import { syncRootModes } from '../../domain/analysis/rootMode.ts';
import { CLASSIFIER_VERSION } from '../../services/classify/rules.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { CollectionService } from '../../domain/collections/CollectionService.ts';
import { collectionReactions } from '../../domain/collections/reactions.ts';
import { reanchorSelections } from '../../domain/collections/roots.ts';
import { analyzeReaction } from '../../domain/analysis/reactions.ts';
import { catalogReactions } from '../../domain/catalog/reactions.ts';
import { declareTagged, dropStalePixivEvidenceReaction, queuePixivCheckReaction, reparseSourceReaction, staleFileEvidenceReaction } from '../../domain/evidence/reactions.ts';
import { jobActor, runAs, type Actor } from '../../propagation/actor.ts';
import type { Change } from '../../propagation/changes.ts';
import { ChangeEvents, engineReactions, type EngineHooks } from '../../propagation/engine.ts';
import { clearWork, hasWork, isPaused, markWork, peekWork, setPaused } from '../../propagation/work.ts';
import { refreshDerived, type DerivedSet } from '../../propagation/versions.ts';
import { shutdownTagger } from '../../services/tagger/client.ts';
import { ARTIST_MODEL, artistPendingCount, createArtistJobRunner } from '../../services/tagger/artists.ts';
import { isModelReady } from '../../services/tagger/download.ts';
import { findModel } from '../../services/tagger/models.ts';
import { createTagStage } from '../../services/tagger/tagJob.ts';
import { createPoseStage, ensurePoseClasses } from '../../services/pose/job.ts';
import { createPoseTagsStage } from '../../services/pose/tagsJob.ts';
import { createPoseMatchStage, ensurePoseWearCatalog } from '../../services/pose/posewearMatch.ts';
import { CharacterCatalog, createCatalog } from '../../domain/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { createDanbooruSyncRunner, hasUncachedArtists, hasUncachedCharacterTags } from '../../services/danbooru/sync.ts';
import { importDictIfNeeded } from '../../services/i18n/dict.ts';
import { SqliteLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { relocalizeAll } from '../../domain/catalog/relocalize.ts';
import { LibraryWatcher, type WatchedRoot } from '../../services/watch/LibraryWatcher.ts';
import { Plugins } from '../../domain/plugins/plugins.ts';
import { config } from '../../config.ts';
import { pendingPixivCount, queueUnseenPixivAnimations, syncPixivCharacters } from '../../services/pixiv/sync.ts';
import { refreshPixivAliases } from '../../services/pixiv/aliases.ts';
import { createPixivDiscovery } from '../../services/pixiv/discovery.ts';
import { DanbooruClient } from '../../services/danbooru/client.ts';
import { CollectionQueries } from './collections.ts';
import { reevaluateAutoReaction } from '../../domain/curation/reevaluate.ts';
import { DuplicateQueries } from './duplicates.ts';
import { SearchQueries } from './search.ts';
import { DedupeService } from '../../services/dedupe/DedupeService.ts';
import { PendingTrash } from '../../domain/library/pendingTrash.ts';
import { resolvePorts, type EnginePorts } from '../../infra/ports.ts';
import { Access } from '../../access/access.ts';
import { CharacterMutations } from '../../domain/catalog/characters.ts';
import { UnrecognizedQueries } from './unrecognized.ts';
import { createContext } from './context.ts';
import { createRegistry } from '../../commands/index.ts';
import type { Registry } from '../../commands/registry.ts';
import { readSettingsView } from '../../readmodel/settings.ts';
import { Derived } from './derived.ts';
import { dropOrphanImageRules, ExclusionQueries, reevaluateExclusionsReaction } from '../../domain/visibility/exclusions.ts';
import { LibraryQueries, type LibraryCounts } from './library.ts';
import { collectReplacementBackups } from '../../domain/library/replace.ts';
import { collectCaches } from '../../domain/analysis/cacheGc.ts';
import {
  deleteRemovedRoots,
} from '../../domain/library/roots.ts';
import { getDanbooruApiKey, patchSettingsInternal, readSettings } from './settings.ts';
import { iso, parseId } from './sql.ts';
import { ACTIVE_ROOT_IDS, FILE_LIVE, HAS_CHARACTER, NOT_EXCLUDED, ROOT_ACTIVE } from '../../readmodel/terms.ts';

/** 启动修补的 actor */
const STARTUP: Actor = 'system:startup';
/** 启动后过多久做缓存回收（低优先级，别和启动扫描、缩略图抢） */
const CACHE_GC_DELAY_MS = 10 * 60_000;

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
  /** 安全模式（docs/plugins.md 第 8 节）；不给按 config（--safe、EMAKI_SAFE=1） */
  safeMode?: boolean;
}

/**
 * 引擎：SQLite（better-sqlite3）+ 文件系统，装配领域模块、读模型、变更传播、后台任务和可替换部件（docs/core-architecture.md 第 3 节）。
 *
 * 它不是一个大接口（P6 删掉了 63 个方法的 DataSource）：所有操作都登记在命令 / 查询注册表里（this.registry，commands/），
 * HTTP、MCP、演示模式、测试都经注册表调用。这里只留装配、启动修补、生命周期，以及命令共用的几个小工具（requireVisibleImages 这类）。
 * 业务逻辑只有这一份实现：演示模式和测试也跑它，只是换掉会产生副作用的部件（infra/ports.ts，第 8 节）。
 *
 * 依赖按 TASKS.md「关键技术决策」安装：T01 better-sqlite3、T03 sharp、T09 onnxruntime-node（精确锁定版本）；
 * 文件监听用 Node 自带的 fs.watch（不装 chokidar），相似查重用 MIH（不用 BK-tree）。
 */
export class SqliteDataSource {
  /** 可替换部件（infra/ports.ts） */
  readonly ports: EnginePorts;
  /** 命令 / 查询注册表（commands/）：所有入口都经它调用 */
  readonly registry: Registry;
  /** 数据库文件；内存库是 null。AI 助手的只读 SQL 直接读它 */
  readonly databaseFile: string | null;

  /** 演示模式（libraryFiles = false）下拒绝会改动用户图库文件夹的操作 */
  requireLibraryFiles(action: string): void {
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
    // 审计记录：上次中途退出、没做完的命令标成 interrupted（同一个 operationId 再来要求先核对），只留最近的一批
    ds.registry.audit.open();
    ds.purgeRemovedRoots();
    // 派生数据的版本（propagation/versions.ts，附录 #23）：版本对不上的整体重算一次再记下。
    // 来源解析：来源变了的由反应清掉过期的 Pixiv 建议、重新登记补充；
    // 内容类型 / 主题 / 质量分（T27）：版本过期的行在 HTTP 监听前同步重算；EMAKI_CLASSIFY=0 跳过（全部按插画统计，保持旧值）
    const derived: DerivedSet[] = [
      {
        name: 'source',
        version: (d) => sourceVersion(readSettings(d).tagger.pixivFilenameMode),
        rebuild: () => ds.ctx.apply(() => ds.ctx.changed({ type: 'image.sourceChanged', ids: backfillSources(db).map((c) => c.id) })),
      },
    ];
    if (process.env.EMAKI_CLASSIFY !== '0')
      derived.push({
        name: 'classification',
        version: () => String(CLASSIFIER_VERSION),
        rebuild: () => {
          const r = classifyStale(db);
          if (!r.rows) return;
          console.log(`[classify] 重算图片类型 ${r.rows} 张，用时 ${r.ms} ms`);
          // 类型变了合集判定可能跟着变（截图、动图页太多的不成册）：启动时全量重判一次
          markWork(db, 'collections', iso(ds.ctx.clock()));
        },
      });
    refreshDerived(db, derived, iso(ds.ctx.clock()));
    // 分类回填之后、HTTP 监听之前：派生数据整体对一遍（按规则重新判定排除结果；合集判定的版本变了、或者上次延后的全量重算没做完时全量重判合集）
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
    const makeCatalog = () => ({ catalog: createCatalog(db, danbooru, localizer), copyrights: danbooru });
    ds.danbooru = danbooru;
    ds.makeCatalog = makeCatalog;
    // 同一个角色被拆成好几个的收拢（换模型后的改名、服装变体归本体；用户 2026-09-28），作品同理：Danbooru 改过名的版权标签，
    // 新旧两个名字各建了一部（用户 2026-09-29）。撞上已有角色走用户手动合并同一个函数。已经收拢过就什么也不做
    const mergeCharacters = (from: number, to: number) => void ds.characters.merge(String(from), String(to));
    const { characters: merged, works } = consolidateCatalog(db, {
      catalog: makeCatalog().catalog,
      localizer,
      merge: mergeCharacters,
      log: (m) => console.log(`[角色] ${m}`),
    });
    if (merged.merged || merged.renamed) console.log(`[角色] 收拢拆开的角色：合并 ${merged.merged} 个，改标签 ${merged.renamed} 个`);
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
        // 识别任务读到的相机：分析模块写，类型变了经变更传播
        applyAnalysis: (fn) => ds.ctx.apply(() => fn((c) => ds.ctx.changed(c))),
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
          mergeCharacters,
          log: (m) => console.log(`[角色] ${m}`),
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
    // 按姿势找图（实验，默认关）：类别随仓库分发，按版本同步进库；打开了才跑任务
    // 补充姿势标签：用户点了才跑（识别新图时已经顺便收了）
    ds.pipeline.register({
      pose: createPoseStage({ ctx: ds.ctx, modelsDir: config.modelsDir, detector: ds.ports.poseDetector }),
      poseTags: createPoseTagsStage({ ctx: ds.ctx, modelsDir: config.modelsDir }),
      // PoseWear 姿势匹配：提取时顺便做；这个任务补骨架、标签换过的图和姿势库升级后的重算（启动后任务链走到时自动排上）
      poseMatch: createPoseMatchStage({ ctx: ds.ctx }),
    });
    if (readSettings(db).pose.enabled) {
      ensurePoseClasses(ds.ctx);
      ensurePoseWearCatalog(ds.ctx);
    }
    // 查重（T16）
    ds.pipeline.register({ dedupe: ds.dedupe });
    // 从没查过重，或查重之后又有新缩略图（重启丢了进程里的标记）→ 下次有机会就查（T26）
    const lastRunAt = readSettings(db).dedupe.lastRunAt;
    const lastThumb = db.prepare('SELECT MAX(thumb_at) FROM images').pluck().get() as string | null;
    if (lastThumb !== null && (lastRunAt === null || lastThumb > lastRunAt || ds.dedupe.needsRecheck())) ds.pipeline.markDedupeDirty();
    // 搜索的标签张数（T20）：打标签结束标记过期，下次搜索时刷新
    // 扫描结束后的钩子（register 支持多个注册者，钩子按注册顺序都调用）。识别、扫描结束后的合集重算由变更传播在任务结束时做
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
    const roots = db.prepare(`SELECT COUNT(*) FROM (${ACTIVE_ROOT_IDS})`).pluck().get() as number;
    if (ds.ports.autoJobs && !process.env.EMAKI_NO_AUTOSCAN && roots > 0) {
      ds.requests.requestFull();
      ds.ctx.jobs.enqueue('scan');
    }
    // 上次没正常退出时留下的待移文件：现在移进系统回收站（撤销栈已经随重启清空了）
    void ds.pendingTrash.flushAll();
    // 启动修补里延后的全量重算（合集）这时做掉，不等第一个后台任务结束
    ds.ctx.propagation.flushDeferred(STARTUP);
    // 缓存回收（附录 #23）：低优先级，启动一会儿之后在后台做一次（只删数据目录里没人引用的缓存文件）
    if (ds.ports.autoJobs) {
      const t = setTimeout(() => void ds.collectCacheGarbage().catch((e) => console.warn(`[缓存回收] 失败：${(e as Error).message}`)), CACHE_GC_DELAY_MS);
      t.unref();
    }
    return ds;
  }

  /** 进程（引擎）开始的时间：之后才建、还没来得及记撤销令牌的替换备份不删 */
  private readonly startedAt = Date.now();

  /**
   * 缓存回收（附录 #23）：缩略图、动图缓存里不再被任何图片引用的文件，撤销令牌已经过期的替换备份，都删掉。
   * 只碰数据目录（dataDir）下这三个缓存目录里、名字是 sha / uuid 的文件，绝不碰用户图库里的文件（domain/analysis/cacheGc.ts）。
   * 扫描正在跑、或者图库还从没扫完过时不做（库刚重建、缩略图缓存还在的情况，扫完会接着用这些缓存）
   */
  async collectCacheGarbage(): Promise<{ thumbs: number; animations: number; backups: number } | null> {
    if (this.ctx.jobs.list().some((j) => j.kind === 'scan' && (j.status === 'running' || j.status === 'queued'))) return null;
    const backups = collectReplacementBackups(this.ctx.dataDir, this.ctx.undo, this.startedAt);
    const caches = await collectCaches(this.ctx.db, this.ctx.dataDir, { keep: backups.keptShas, roots: this.rootPaths() });
    if (!caches) return { thumbs: 0, animations: 0, backups: backups.removed };
    const out = { ...caches, backups: backups.removed };
    if (out.thumbs || out.animations || out.backups) console.log(`[缓存回收] 删掉缩略图 ${out.thumbs} 个、动图缓存 ${out.animations} 个、替换备份 ${out.backups} 份`);
    return out;
  }

  /** 所有图库文件夹（包括停用、移除了的）的路径：缓存回收确认缓存目录和它们不重叠 */
  private rootPaths(): string[] {
    return this.ctx.db.prepare('SELECT path FROM library_roots').pluck().all() as string[];
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
  localizer!: Localizer;
  /** 每次新建一个带完整回退链的角色目录（缓存只在一次请求内有效） */
  makeCatalog!: () => { catalog: CharacterCatalog; copyrights: DanbooruCatalog };
  /**
   * 现在的角色目录：启动早期（Danbooru 缓存、词库还没接上，启动修补就可能触发 reevaluateAuto）用只带打包作品表的基本目录
   */
  /**
   * reevaluateAuto 用的角色目录：每个事务都要评估一次（识别任务一批一次），每次新建要重新准备十来条语句。
   * 启动完成后复用同一个，每次用之前清掉标签 → 角色的缓存（期间角色可能被合并、建档、撤销）
   */
  private cachedAutoCatalog: CharacterCatalog | null = null;
  private autoCatalog(): CharacterCatalog {
    if (!this.makeCatalog) return this.catalogNow();
    this.cachedAutoCatalog ??= this.makeCatalog().catalog;
    this.cachedAutoCatalog.clearCache();
    return this.cachedAutoCatalog;
  }
  /** 现在的角色目录（启动早期还没接上 Danbooru 缓存时是只带打包作品表的基本目录） */
  catalogNow(): CharacterCatalog {
    if (this.makeCatalog) return this.makeCatalog().catalog;
    return new CharacterCatalog(this.ctx.db, { copyrights: CopyrightResolver.fromAsset(this.ctx.db) });
  }
  readonly characters: CharacterMutations;
  readonly unrecognized: UnrecognizedQueries;
  /** 移到回收站的延后执行（最近几次可撤销） */
  readonly pendingTrash: PendingTrash;
  /** 合集（T38b）；什么时候重算由变更传播的反应决定（domain/collections/reactions.ts） */
  readonly collections: CollectionService;
  /** changed 事件的推送（按 actor 节流） */
  private readonly events: ChangeEvents;
  readonly duplicates: DuplicateQueries;
  /** ⌘K 搜索（T20） */
  readonly searchQueries: SearchQueries;
  /** 查重（T16） */
  readonly dedupe: DedupeService;
  /** 角色 / 作品聚合缓存（T13） */
  readonly derived: Derived;
  /** 统计、别册汇总、图片总数的两级失效缓存（T22） */
  readonly results: SoftCache<unknown>;
  readonly library: LibraryQueries;
  readonly collectionQueries: CollectionQueries;
  readonly exclusions: ExclusionQueries;
  /** 最近的改动：自动关联、Pixiv 补充、移动到文件夹（重启后也能撤回） */
  readonly changes: ChangeLog;
  /** 设备与访问（docs/mobile.md 第 2 节）：局域网入口的配置、配对、设备凭证 */
  readonly access: Access;
  /** 插件管理（docs/plugins.md 第 9 节）：启用、改名、覆盖的值、侧栏 */
  readonly plugins: Plugins;

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
    this.ctx.propagation.onJobFinished((kind) => this.events.flush(kind, jobActor(kind)));
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
      // 用户的暂停也持久化在 pending_work（第 7 节）
      pauses: {
        get: (kind) => isPaused(db, kind),
        set: (kind, paused) => setPaused(db, kind, paused, iso(this.ctx.clock())),
      },
    });
    // 后台任务写库后，统计类结果最多晚 10 秒更新（T22）；测试（内存库）里不延迟
    const softMs = opts.memory ? 0 : 10_000;
    this.results = new SoftCache<unknown>({ softMs, maxMs: 5 * 60_000, max: 200 });
    this.derived = new Derived(this.ctx, softMs);
    this.collections = new CollectionService(db, this.ctx.clock);
    this.collectionQueries = new CollectionQueries(this.ctx, this.collections, this.derived, () => this.makeCatalog().catalog);
    this.library = new LibraryQueries(this.ctx, this.derived, () => this.collectionQueries.stats());
    this.pendingTrash = new PendingTrash(this.ctx, { trashImpl: this.ports.trashImpl, checkRoot: this.ports.checkRecyclable });
    this.unrecognized = new UnrecognizedQueries(this.ctx, () => this.makeCatalog().catalog, softMs);
    this.characters = new CharacterMutations(this.ctx, this.derived, () => this.danbooru, () => this.makeCatalog().catalog);
    this.exclusions = new ExclusionQueries(this.ctx);
    this.changes = new ChangeLog(this.ctx);
    this.access = new Access({ db, bus, dataDir, clock: this.ctx.clock });
    this.plugins = new Plugins(this.ctx, opts.safeMode ?? config.safeMode);
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
    this.registry = createRegistry(this);
    // 扫描 / 识别跑完后行数可能变了很多（首次导入）：查询统计过期会让列表走错计划（T22）
    bus.subscribe((e) => {
      if (e.type !== 'job') return;
      if (e.job.status === 'done' && (e.job.kind === 'scan' || e.job.kind === 'tag')) refreshPlannerStats(db);
      // 审计记录：后台任务每跑完一轮记一行（actor job:<任务>），在「谁改的」里查得到
      if ((e.job.status === 'done' || e.job.status === 'failed' || e.job.status === 'cancelled') && db.open) {
        const who = jobActor(e.job.kind);
        this.registry.audit.record({ command: who, actor: who }, { status: e.job.status === 'failed' ? 'failed' : 'done', message: e.job.message });
      }
    });
    this.optimizeTimer = setInterval(() => {
      db.pragma('optimize');
      refreshPlannerStats(db);
    }, 3_600_000);
    this.optimizeTimer.unref();
  }

  /**
   * 反应注册表（docs/core-architecture.md 第 5.2 节，docs/ARCHITECTURE.md「变更传播」）。同一阶段按这里的顺序执行：
   * 事务内：重新解析来源 → 文件内容变了时识别过期 → 分析（入库、内容变化、移动、漫画区） → 过期的 Pixiv 建议 → 自动决定 → 排除结果 → Pixiv 补充登记
   *   → 同投稿组 → 文件夹合集 → 合集页序；
   * 排队：查重标记、识别、缩略图、画师、Pixiv、本地重新匹配、重新扫描；提交后：全量合集、自建角色匹配、设置和文件夹监听、缓存和事件
   */
  private registerReactions(): void {
    const db = this.ctx.db;
    const p = this.ctx.propagation;
    const visible = (rootId: number) => !!db.prepare(`SELECT 1 FROM library_roots WHERE id = ? AND ${ROOT_ACTIVE('')}`).get(rootId);
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
        const settings = readSettingsView(this.ctx);
        for (const fn of this.settingsListeners) fn(settings);
      },
      rootsChanged: () => {
        for (const fn of this.rootsListeners) fn();
      },
      pendingTag: (ids) =>
        !!ids.length &&
        !!db
          .prepare(
            `SELECT 1 FROM images i WHERE i.id IN (SELECT value FROM json_each(?)) AND (i.tagged_at IS NULL OR i.retag = 1)
             AND ${NOT_EXCLUDED('i')} AND ${FILE_LIVE('i')} AND NOT ${IN_COMIC('i')} LIMIT 1`,
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
      // 文件内容变了（D1）：先把这份文件版本的识别标成过期，分析再按「还没识别」重算主题、画质分
      staleFileEvidenceReaction,
      analyzeReaction,
      dropStalePixivEvidenceReaction,
      // 唯一的自动决定规则（decideAuto）：证据、类型、放下、原创、否决、合集、漫画区、编目变了都重新评估（第 4.2 节）
      reevaluateAutoReaction({ catalog: () => this.autoCatalog() }),
      reevaluateExclusionsReaction,
      queuePixivCheckReaction,
      ...collectionReactions(this.collections, p, this.ctx.clock),
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
    return (this.ctx.db.prepare(`SELECT id, path FROM library_roots WHERE ${ROOT_ACTIVE('')}`).all() as { id: number; path: string }[]).map(
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
    this.access.close();
    this.danbooru?.offlineCharacters?.close();
    closeDatabase(this.ctx.db);
  }

  // ---------------------------------------------------------------- 命令和查询共用的小工具（commands/）

  /** 统计和汇总共用一遍扫描（两级缓存，T22） */
  counts(): LibraryCounts {
    return this.results.get('counts', () => this.library.readCounts()) as LibraryCounts;
  }

  /** 可见的图（在 v_images 里，包括被排除的）；有一张不可见或不存在就 NotFoundError('图片') */
  requireVisibleImages(ids: ID[]): number[] {
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

  requireCharacterId(id: ID): number {
    const n = parseId(id);
    if (n === null || !this.ctx.stmt('SELECT 1 FROM characters WHERE id = ?').get(n)) throw new NotFoundError('角色');
    return n;
  }

  // ---------------------------------------------------------------- 设置、图库文件夹的监听者
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
      // 跨文件夹选的合集活得比它原来挂靠的文件夹久：先换个挂靠（合集模块）
      reanchorSelections(db, cutoff);
      const roots = deleteRemovedRoots(db, cutoff);
      // 指向已经删掉的图的单张排除规则（可见性模块）
      const ex = dropOrphanImageRules(db);
      if (roots || ex) console.log(`已清理移除的文件夹 ${roots} 个、失效的单张排除 ${ex} 条`);
    })();
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
           EXISTS (SELECT 1 FROM v_character_suggestions cs WHERE cs.image_id = i.id AND cs.source = 'pixiv')
           OR ${HAS_CHARACTER('i')})`,
      )
      .pluck()
      .get(JSON.stringify(cachedIds)) as number;
  }

  requireRoot(id: ID): { id: number; path: string; enabled: number } {
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

  /**
   * 停用、移除期间磁盘上的变化监听器收不到，全量扫描也跳过这个文件夹：重新启用（包括撤销停用、撤销移除）时整个扫一遍。
   * 扫描正在跑时也再排一次，别丢了这个请求
   */
  private rescanRoot(rootId: number): void {
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
  }
}
