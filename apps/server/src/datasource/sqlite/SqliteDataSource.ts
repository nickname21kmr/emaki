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
  ContentKindSummary,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CreateExclusionBody,
  DuplicateGroup,
  Exclusion,
  GetCharacterResponse,
  ID,
  ImageDetail,
  ImageFormat,
  ImageItem,
  Job,
  JobKind,
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
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
  UpdateLibraryRootBody,
  UpdateArtistLinksBody,
  Rating,
  Work,
} from '@emaki/shared';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EventBus } from '../../core/events.ts';
import { JobQueue } from '../../core/jobs.ts';
import { done, UndoStack } from '../../core/undo.ts';
import { closeDatabase, openDatabase, transact, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { SoftCache } from './softCache.ts';
import { consolidateCharacterTags, consolidateWorkTags } from './consolidate.ts';
import { BadRequestError, ConflictError, NeedsConfirmError, NotFoundError, NotImplementedError } from '../../http/errors.ts';
import type { DataSource, FileResponse } from '../DataSource.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { revealInFileManager } from '../../services/fs/reveal.ts';
import { ThumbnailService, type ThumbRow } from '../../services/image/ThumbnailService.ts';
import { thumbPath } from '../../services/image/pixels.ts';
import { Pipeline } from '../../services/pipeline.ts';
import { Scanner } from '../../services/scan/Scanner.ts';
import { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { backfillSources } from '../../services/source/backfill.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { syncRootModes } from '../../services/classify/rootMode.ts';
import { ComicAreas } from '../../services/classify/comicAreas.ts';
import { CollectionService, type CollectionsHook } from '../../services/collections/CollectionService.ts';
import { shutdownTagger } from '../../services/tagger/client.ts';
import { ARTIST_MODEL, artistPendingCount, createArtistJobRunner } from '../../services/tagger/artists.ts';
import { isModelReady } from '../../services/tagger/download.ts';
import { findModel } from '../../services/tagger/models.ts';
import { createTagStage } from '../../services/tagger/tagJob.ts';
import { resetIoBackoff } from '../../services/tagger/readBackoff.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { createDanbooruSyncRunner, hasUncachedArtists, hasUncachedCharacterTags } from '../../services/danbooru/sync.ts';
import { importDictIfNeeded } from '../../services/i18n/dict.ts';
import { SqliteLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { relocalizeAll } from '../../services/i18n/relocalize.ts';
import { LibraryWatcher, type WatchedRoot } from '../../services/watch/LibraryWatcher.ts';
import { config } from '../../config.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import { listImages } from './queries/listImages.ts';
import { loadSuggestions } from './suggestions.ts';
import { BulkOps, RATING_LABEL } from './bulk.ts';
import { CollectionQueries } from './collections.ts';
import { assertKindValue, KIND_LABEL, setKindInTx, type KindDeps } from './kinds.ts';
import { describeKindReason } from './hydrate.ts';
import { DuplicateQueries } from './duplicates.ts';
import { SearchQueries } from './search.ts';
import { DedupeService } from '../../services/dedupe/DedupeService.ts';
import type { TrashImpl } from '../../services/trash/recycleBin.ts';
import { CharacterMutations } from './characters.ts';
import { UnrecognizedQueries } from './unrecognized.ts';
import { createContext } from './context.ts';
import { Derived } from './derived.ts';
import { applyExclusionRules, ExclusionQueries } from './exclusions.ts';
import { LibraryQueries } from './library.ts';
import { TagResultWriter } from '../../services/tagger/writer.ts';
import { moveBack, moveImageFiles, normalizeSubdir, type MoveRow } from './move.ts';
import { artistNames, imageArtists, linkGroups, listArtists as listArtistsQuery, tagNames } from './artists.ts';
import { artistLinksMessage, linkTags, planArtistLinks } from '../artistEdits.ts';
import { diskCaseRel, mergeChildRoots, relUnder, type ChildRoot } from './roots.ts';
import { applySettingsPatch, getDanbooruApiKey, isInside, normalizeRootPath, patchSettingsInternal, readSettings, samePath } from './settings.ts';
import { iso, MIME, parseId, toId, VISIBLE } from './sql.ts';

/** 改图库文件夹的导入方式会改这些列（撤销用） */
const ROOT_MODE_COLS = ['content_kind', 'content_kind_source', 'content_kind_evidence', 'content_kind_version', 'theme', 'art_score', 'rating'];
type RootImageSnap = { id: number; tagged_at: string | null } & Record<string, unknown>;

export interface SqliteOpenOptions {
  /** 内存库（测试用） */
  memory?: boolean;
  clock?: () => number;
  /** 启动时是否自动组装任务链并扫描（T07），测试里关掉 */
  autoJobs?: boolean;
  /** 启动时导入中文词库（T12，约 0.7 秒）；契约测试里关掉 */
  importDict?: boolean;
  /** 替换系统回收站（测试用） */
  trashImpl?: TrashImpl;
}

/**
 * 真实数据源：SQLite（better-sqlite3）+ 文件系统。
 *
 * 实现顺序和每个方法的验收标准见 docs/TASKS.md，方法上的 T 编号就是任务编号。
 * 参考实现：datasource/mock/MockDataSource.ts —— 行为（排序、过滤、撤销、事件）要和它一致，
 * 这样前端不用改就能切过来。
 *
 * 依赖按 TASKS.md「关键技术决策」安装：T01 better-sqlite3、T03 sharp、T09 onnxruntime-node（精确锁定版本）；
 * 文件监听用 Node 自带的 fs.watch（不装 chokidar），相似查重用 MIH（不用 BK-tree）。
 */
export class SqliteDataSource implements DataSource {
  /**
   * T01：打开 / 创建 `${dataDir}/emaki.sqlite`，开启 WAL 和外键，跑迁移（db/migrate.ts），
   * 创建 UndoStack 和 JobQueue（runner 由 T07 接上 services/*）。
   */
  static async open(bus: EventBus, dataDir: string, opts: SqliteOpenOptions = {}): Promise<SqliteDataSource> {
    await mkdir(dataDir, { recursive: true });
    const db = openDatabase(opts.memory ? ':memory:' : path.join(dataDir, 'emaki.sqlite'));
    migrate(db, { backupDir: opts.memory ? undefined : dataDir, log: (m) => console.log(m) });
    db.pragma('optimize = 0x10002'); // 长连接：打开时一次，之后每小时一次
    if (refreshPlannerStats(db)) console.log('[db] 行数变化较大，已重新采样查询统计');
    const ds = new SqliteDataSource(db, bus, dataDir, opts);
    ds.purgeRemovedRoots();
    backfillSources(db); // 来源解析规则升级后重算
    // 内容类型 / 主题 / 质量分（T27）：规则版本过期的行在 HTTP 监听前同步重算；EMAKI_CLASSIFY=0 跳过（全部按插画统计，保持旧值）
    if (process.env.EMAKI_CLASSIFY !== '0') {
      const r = backfillClassification(db);
      if (r.rows) console.log(`[classify] 重算图片类型 ${r.rows} 张，用时 ${r.ms} ms`);
    }
    // 合集（T38b）：分类回填之后、HTTP 监听之前全量重算一次
    if (process.env.EMAKI_COLLECTIONS !== '0') {
      const r = ds.collections.refreshAll();
      console.log(`合集：${r.active} 本（新建 ${r.created} · 删除 ${r.removed} · 更新 ${r.updated}）· ${Math.round(r.ms)} ms`);
    }
    if (opts.autoJobs !== false) ds.startWatching();
    ds.autoTag = opts.autoJobs !== false;
    // 识别角色（T10）。T11 / T20 之后在这里继续 register
    // 角色 → 作品的完整回退链 + 标签规范化（改名、服装变体归本体）来自 Danbooru 缓存（T11）
    const danbooru = new DanbooruCatalog(db, CopyrightResolver.fromAsset(db));
    // 中文名（T12）：随仓库分发的词库，版本变了才重新导入；导入后全库重算显示名
    const dict = opts.importDict === false ? { imported: false } : importDictIfNeeded(db);
    const localizer: Localizer = new SqliteLocalizer(db, danbooru);
    if (dict.imported) db.transaction(() => relocalizeAll(db, localizer))();
    const makeCatalog = () => ({
      catalog: new CharacterCatalog(db, { copyrights: danbooru, localizer, normalizeTag: (t) => danbooru.normalizeTag(t) }),
      copyrights: danbooru,
    });
    ds.danbooru = danbooru;
    ds.makeCatalog = makeCatalog;
    // 同一个角色被拆成好几个的收拢（换模型后的改名、服装变体归本体；用户 2026-09-28）。已经收拢过就什么也不做
    const merged = consolidateCharacterTags(db, {
      normalizeTag: (t) => danbooru.normalizeTag(t),
      localizer,
      merge: (from, to) => void ds.characters.merge(String(from), String(to)),
      log: (m) => console.log(`[角色] ${m}`),
    });
    if (merged.merged || merged.renamed) console.log(`[角色] 收拢拆开的角色：合并 ${merged.merged} 个，改标签 ${merged.renamed} 个`);
    // 作品同理：Danbooru 改过名的版权标签，新旧两个名字各建了一部（用户 2026-09-29）
    const works = consolidateWorkTags(db, { canonicalize: (t) => danbooru.canonicalize(t), localizer });
    if (works.merged || works.renamed) console.log(`[作品] 收拢改过名的作品：合并 ${works.merged} 部，改标签 ${works.renamed} 部`);
    ds.pipeline.register({
      tag: createTagStage({
        db,
        bus,
        modelsDir: config.modelsDir,
        getTaggerSettings: () => readSettings(db).tagger,
        makeCatalog,
        afterBatchInTx: (ids) => applyExclusionRules(ds.ctx, { imageIds: ids }),
        log: (m) => console.info(`[tag] ${m}`),
      }),
      danbooru: {
        shouldRunAfterTag: () => readSettings(db).danbooru.enabled && (hasUncachedCharacterTags(db) || hasUncachedArtists(db)),
        run: createDanbooruSyncRunner({
          db,
          danbooru,
          getCatalog: () => makeCatalog().catalog,
          localizer,
          relocalizeAll,
          getDanbooru: () => ({ ...readSettings(db).danbooru, apiKey: getDanbooruApiKey(db) }),
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
    if (lastThumb !== null && (lastRunAt === null || lastThumb > lastRunAt)) ds.pipeline.markDedupeDirty();
    // 搜索的标签张数（T20）：打标签结束立即刷新
    // register 是覆盖式的：识别结束、扫描结束后的钩子都写在这一处
    ds.pipeline.register({
      afterTag: () => {
        ds.searchQueries.refreshNow();
        ds.refreshCollections('tag');
      },
      // 扫描有变化才重算合集（RV-C-9）：延后重扫大约 3 秒一次，没变化时不要全量读库
      afterScan: (s) => {
        // 扫描按开始时的导入方式判类型：中途切换过的、在磁盘上移进移出漫画文件夹的，按现在的设置改过来
        const synced = syncRootModes(db);
        if (synced) ds.ctx.invalidate('all');
        if (synced || s.added + s.updated + s.moved + s.missing + s.restored > 0) ds.refreshCollections('scan');
      },
    });
    const roots = db.prepare('SELECT COUNT(*) FROM library_roots WHERE enabled = 1 AND removed_at IS NULL').pluck().get() as number;
    if (opts.autoJobs !== false && !process.env.EMAKI_NO_AUTOSCAN && roots > 0) {
      ds.requests.requestFull();
      ds.ctx.jobs.enqueue('scan');
    }
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
  /** 每次新建一个带完整回退链的角色目录（缓存只在一次请求内有效） */
  makeCatalog!: () => { catalog: CharacterCatalog; copyrights: DanbooruCatalog };
  private readonly characters: CharacterMutations;
  private readonly unrecognized: UnrecognizedQueries;
  private readonly bulk: BulkOps;
  private readonly kindDeps: KindDeps;
  /** 合集（T38b） */
  readonly collections: CollectionService;
  /** 写操作之后重算合集；EMAKI_COLLECTIONS=0 时什么也不做 */
  private readonly collectionsHook: CollectionsHook = (undo, ids) => {
    if (process.env.EMAKI_COLLECTIONS === '0') return;
    const run = () => void (ids === 'all' ? this.collections.refreshAll() : this.collections.refreshDirs(ids));
    run();
    undo?.onUndo(run);
  };
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

  protected constructor(db: Db, bus: EventBus, dataDir: string, opts: SqliteOpenOptions) {
    const jobs = new JobQueue(bus, (kind) => this.pipeline.runner(kind));
    this.ctx = createContext({ db, bus, dataDir, clock: opts.clock ?? Date.now, undo: new UndoStack(), jobs });
    this.thumbs = new ThumbnailService({
      db,
      thumbsRoot: path.join(dataDir, 'thumbs', 'v1'),
      now: this.ctx.clock,
      onCamerasUpdated: () => {
        this.ctx.invalidate('all');
        bus.emit({ type: 'library-changed', reason: 'scan' });
      },
    });
    this.scanner = new Scanner({
      db,
      bus,
      dataDir,
      requests: this.requests,
      // T17：新扫描进来的图也要套用排除规则（文件夹规则）
      onNewImagesInTx: (ids) => applyExclusionRules(this.ctx, { imageIds: ids }),
    });
    this.pipeline = new Pipeline({
      jobs: () => this.ctx.jobs,
      requests: this.requests,
      scanner: this.scanner,
      thumbs: this.thumbs,
      pixelPendingCount: () => this.thumbs.pendingCount(),
    });
    // 后台任务写库后，统计类结果最多晚 10 秒更新（T22）；测试（内存库）里不延迟
    const softMs = opts.memory ? 0 : 10_000;
    this.results = new SoftCache<unknown>({ softMs, maxMs: 5 * 60_000, max: 200 });
    this.derived = new Derived(this.ctx, softMs);
    this.collections = new CollectionService(db, this.ctx.clock);
    this.collectionQueries = new CollectionQueries(this.ctx, this.collections, this.derived);
    this.library = new LibraryQueries(this.ctx, this.derived, () => this.collectionQueries.stats());
    this.kindDeps = { catalog: () => this.makeCatalog().catalog, autoAcceptThreshold: () => readSettings(db).tagger.autoAcceptThreshold };
    this.bulk = new BulkOps(this.ctx, (ids) => this.requireVisibleImages(ids), this.kindDeps, this.collectionsHook);
    this.unrecognized = new UnrecognizedQueries(this.ctx, () => this.makeCatalog().catalog, softMs);
    this.characters = new CharacterMutations(this.ctx, this.derived, () => this.danbooru, () => this.makeCatalog().catalog);
    this.exclusions = new ExclusionQueries(this.ctx, this.collectionsHook);
    this.duplicates = new DuplicateQueries(this.ctx, opts.trashImpl, this.collectionsHook);
    this.searchQueries = new SearchQueries(db, this.derived);
    this.dedupe = new DedupeService({
      db,
      clock: this.ctx.clock,
      getThreshold: () => readSettings(db).dedupe.hammingThreshold,
      thumbFile: (sha) => thumbPath(path.join(dataDir, 'thumbs', 'v1'), sha, 240),
      onChanged: () => this.ctx.invalidate('all'),
      onFinished: (at) => patchSettingsInternal(db, 'dedupe', { lastRunAt: at }),
    });
    this.ctx.onInvalidate((_scope, o) => {
      this.derived.invalidate(o.soft);
      this.unrecognized.invalidate(o.soft);
      this.results.invalidate(o.soft);
    });
    // 扫描器 / 后台任务直接写库，靠事件让缓存失效
    bus.subscribe((e) => {
      if (e.type === 'library-changed') {
        // 用户操作已经在 touch() 里硬失效过；这里是扫描 / 识别等后台任务直接写库：软失效
        const soft = e.reason !== 'mutation';
        this.derived.invalidate(soft);
        this.unrecognized.invalidate(soft);
        this.results.invalidate(soft);
        this.searchQueries.scheduleRefresh();
      }
    });
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
    await shutdownTagger(); // 关掉推理子进程，释放显存
    clearInterval(this.optimizeTimer);
    this.searchQueries.dispose();
    closeDatabase(this.ctx.db);
  }

  /** 后台任务之后重算合集；有变化才让缓存失效并通知前端（T38b） */
  refreshCollections(reason: 'scan' | 'tag' | 'mutation'): void {
    if (process.env.EMAKI_COLLECTIONS === '0') return;
    const r = this.collections.refreshAll();
    if (r.created + r.removed + r.updated + r.pagesChanged > 0) {
      this.ctx.invalidate('all');
      this.ctx.bus.emit({ type: 'library-changed', reason });
    }
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
    const json = JSON.stringify(tags);
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      u.set('artist_links', 'tag IN (SELECT value FROM json_each(?))', [json]);
      db.prepare('DELETE FROM artist_links WHERE tag IN (SELECT value FROM json_each(?))').run(json);
      if (body.mode !== 'auto') {
        const ins = db.prepare('INSERT INTO artist_links (tag, group_tag, created_at) VALUES (?, ?, ?)');
        for (const t of tags) ins.run(t, into ?? null, now);
      }
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
    return this.collectionQueries.create(body);
  }
  async updateCollection(id: ID, body: UpdateCollectionBody): Promise<MutationResult> {
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
      kindSource: row.content_kind_manual ? 'manual' : row.content_kind_source,
      kindReason: row.content_kind_manual ? null : describeKindReason(row.content_kind_source, row.content_kind_evidence),
      collection: this.imageCollection(n),
      artists: imageArtists(this.ctx.db, n),
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
      | { id: number; kind: 'doujin' | 'artbook'; title: string | null; volume_no: number | null; rel_dir: string; ord: number; n: number }
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
    // 类型、收藏、分级、角色放进同一次 mutate：一起传时一个 token 撤销全部
    return this.ctx.mutate((u) => {
      // 提示文案和 mock 一致：收藏 > 分级 > 角色 > 类型，只报一条
      let message = '';
      if (body.kind !== undefined) {
        const value = body.kind;
        setKindInTx(this.ctx, u, [iid], value, this.kindDeps);
        this.collectionsHook(u, [iid]);
        message = value === 'auto' ? '已恢复自动判断' : `已标为「${KIND_LABEL[value]}」`;
      }
      const cols = [
        ...(body.rating ? ['rating', 'rating_manual'] : []),
        ...(body.favorite !== undefined ? ['favorite'] : []),
      ];
      u.columns('images', cols, [iid]);
      if (charIds) {
        u.set('image_characters', 'image_id = ?', [iid]);
        const ids = JSON.stringify(charIds);
        this.ctx.stmt('DELETE FROM image_characters WHERE image_id = @iid AND character_id NOT IN (SELECT value FROM json_each(@ids))').run({ iid, ids });
        this.ctx
          .stmt(
            `INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
             SELECT @iid, value, 'manual', NULL, @now FROM json_each(@ids)`,
          )
          .run({ iid, ids, now });
        message = '已更新角色';
      }
      // 手动改分级要记下来：T10 重打标签时不覆盖
      if (body.rating) {
        this.ctx.stmt('UPDATE images SET rating = ?, rating_manual = 1 WHERE id = ?').run(body.rating, iid);
        message = '已修改分级';
      }
      if (body.favorite !== undefined) {
        this.ctx.stmt('UPDATE images SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, iid);
        message = body.favorite ? '已收藏' : '已取消收藏';
      }
      return { message: message || '已更新' };
    });
  }
  async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
    const n = parseId(id);
    if (n === null) return null;
    // 不要求「可见」：排除页和已处理的重复组都要显示被排除或已删除图片的缩略图（mock 也是这样）
    const row = this.ctx
      .stmt('SELECT i.id, i.sha256, i.format, i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as ThumbRow | undefined;
    if (!row) return null;
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

  /** 不要求可见（和 mock 一样）；文件不在了返回 null → 404 */
  async getOriginal(id: ID): Promise<FileResponse | null> {
    const n = parseId(id);
    if (n === null) return null;
    const row = this.ctx
      .stmt('SELECT i.sha256, i.format, i.rel_path, r.path AS root_path FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ?')
      .get(n) as { sha256: string; format: ImageFormat; rel_path: string; root_path: string } | undefined;
    if (!row) return null;
    const abs = toAbs(row.root_path, row.rel_path);
    try {
      await access(abs);
    } catch {
      return null;
    }
    return { kind: 'path', contentType: MIME[row.format], filePath: abs, etag: `"${row.sha256.slice(0, 20)}"`, cacheControl: 'private, no-cache' };
  }

  async revealImage(id: ID): Promise<void> {
    const n = this.requireVisibleImages([id])[0]!;
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
    const r = await this.bulk.run(body);
    // 画师改回自动：能自动续补时马上重新认这几张（用户暂停过补跑就不拉起来）
    if (body.action.type === 'artist-auto') this.pipeline.requestArtists();
    return r;
  }

  async moveImages(body: MoveImagesBody): Promise<MutationResult> {
    const root = this.requireRoot(body.rootId);
    if (!root.enabled) throw new BadRequestError('这个图库文件夹停用了，先启用再移动');
    const dir = normalizeSubdir(body.dir);
    const cols = `i.id, i.root_id, i.rel_path, i.file_name, i.collection_id, i.tagged_at, i.retag, r.path AS root_path`;
    let rows: (MoveRow & { tagged_at: string | null; retag: number })[];
    if (body.characterId !== undefined) {
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
    if (!rows.length) throw new BadRequestError('没有可以移动的图');

    // 扫描、识别正在读这些文件时不能移（扫描会把移走的图当成丢失）
    const running = (await this.ctx.jobs.list()).filter((j) => j.status === 'running').map((j) => j.kind);
    if (running.includes('scan')) throw new ConflictError('正在扫描图库，等扫描结束再移动');
    if (running.includes('tag') && rows.some((r) => r.tagged_at === null || r.retag)) {
      throw new ConflictError('正在识别，选中的图里有还没识别完的，等识别结束再移动');
    }

    const dest = { rootId: root.id, rootPath: root.path, dir };
    const out = moveImageFiles(this.ctx.db, rows, dest);
    const ids = out.moved.map((m) => m.id);
    // 移进了被排除的文件夹：照规则排除；移进 / 移出按漫画导入的文件夹：类型、分级跟着文件夹
    if (ids.length)
      this.ctx.db.transaction(() => {
        applyExclusionRules(this.ctx, { imageIds: ids });
        syncRootModes(this.ctx.db, ids);
      })();
    this.ctx.touch();

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
    return this.ctx.undo.result(message, async () => {
      if ((await this.ctx.jobs.list()).some((j) => j.status === 'running' && j.kind === 'scan')) {
        throw new ConflictError('正在扫描图库，等扫描结束再撤销');
      }
      const back = moveBack(this.ctx.db, out.moved);
      syncRootModes(this.ctx.db, ids);
      this.ctx.touch();
      if (back.failed.length) throw new ConflictError(`移回了 ${back.restored} 张，${back.failed.length} 张没能移回（文件或位置已经变了）`);
    });
  }

  // T15 未识别
  async listUnrecognized(query: ListUnrecognizedQuery): Promise<ListUnrecognizedResponse> {
    return this.unrecognized.list(query);
  }

  async unrecognizedSummary(): Promise<UnrecognizedSummary> {
    return this.unrecognized.summary();
  }
  async acceptSuggestion(imageId: ID, danbooruTag: string): Promise<MutationResult> {
    return this.unrecognized.accept(imageId, danbooruTag);
  }
  async retagUnrecognized(): Promise<RetagResult> {
    this.unrecognized.markRetag();
    // 之前标过、还没跑完的也算：只要有等着重新识别的，就启动识别任务
    const pending = this.ctx.stmt('SELECT COUNT(*) AS n FROM images WHERE retag = 1').get() as { n: number };
    return { marked: pending.n, job: pending.n ? await this.startJob('tag') : null };
  }

  // T16 查重
  async listDuplicates(query: ListDuplicatesQuery): Promise<DuplicateGroup[]> {
    return this.results.get(`dups:${query.resolved ? 1 : 0}`, () => this.duplicates.list(query)) as DuplicateGroup[];
  }
  async resolveDuplicate(id: ID, keepIds: ID[]): Promise<MutationResult> {
    return this.duplicates.resolve(id, keepIds);
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
    return this.searchQueries.search(query);
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

  private notifyRoots(): void {
    for (const fn of this.rootsListeners) fn();
  }

  /** 启动时真正删除上次「移除」的文件夹（级联删除它的图）和指向已删除图片的单张排除规则 */
  purgeRemovedRoots(): void {
    const db = this.ctx.db;
    db.transaction(() => {
      const roots = db.prepare('DELETE FROM library_roots WHERE removed_at IS NOT NULL').run().changes;
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

  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    const before = readSettings(this.ctx.db).tagger.autoAcceptThreshold;
    const beforeArtists = readSettings(this.ctx.db).tagger.artists;
    applySettingsPatch(this.ctx.db, body as Parameters<typeof applySettingsPatch>[1]);
    const settings = await this.getSettings();
    // 调低自动采纳阈值：已达标的建议当场归到角色（和识别任务开头的「阶段 0」同一段逻辑）
    if (settings.tagger.autoAcceptThreshold < before) {
      const t = settings.tagger;
      const { catalog, copyrights } = this.makeCatalog();
      const writer = new TagResultWriter(this.ctx.db, catalog, copyrights, {
        repo: t.model,
        generalThreshold: t.generalThreshold,
        characterThreshold: t.characterThreshold,
        autoAcceptThreshold: t.autoAcceptThreshold,
      });
      const promoted = writer.promoteSuggestions();
      if (promoted) {
        this.ctx.db.transaction(() => catalog.backfillWorks(new Date(this.ctx.clock()).toISOString()))();
        this.refreshCollections('mutation');
      }
    }
    // 刚打开「识别画师」：给已识别的图补跑（任务在显卡道里排在识别后面，可以随时取消）
    if (body.tagger?.artists === true && !beforeArtists) {
      this.pipeline.noteManualStart('artists');
      this.ctx.jobs.enqueue('artists');
    }
    // 关掉：正在跑和排队中的补跑一起停（关了开关，设置页的进度和取消按钮也没了）
    if (body.tagger?.artists === false && beforeArtists) {
      for (const j of this.ctx.jobs.list()) if (j.kind === 'artists' && (j.status === 'queued' || j.status === 'running')) this.ctx.jobs.cancel(j.id);
    }
    for (const fn of this.settingsListeners) fn(settings);
    this.ctx.touch();
    return settings;
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
    const p = normalizeRootPath(body.path);
    try {
      const st = await stat(p);
      if (!st.isDirectory()) throw new BadRequestError('这不是一个文件夹');
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new BadRequestError('没有权限读取这个文件夹');
      throw new BadRequestError(`找不到这个文件夹：${p}`);
    }

    const db = this.ctx.db;
    const mode = body.mode === 'comic' ? 'comic' : 'auto';
    const comicRating = body.comicRating ?? 'general';
    const rows = db.prepare('SELECT id, path, enabled, removed_at, imported_at, content_mode FROM library_roots').all() as (ChildRoot & {
      enabled: number;
      content_mode: string;
    })[];
    const active = rows.filter((r) => r.removed_at === null);
    if (active.some((r) => samePath(r.path, p))) throw new BadRequestError('这个文件夹已经在图库里了');
    const parent = active.find((r) => isInside(p, r.path));
    // 已有图库文件夹里面的子文件夹：选了漫画就把这个子文件夹按漫画导入，不另加图库文件夹
    if (parent && mode === 'comic') return this.setComicFolder(parent, await diskCaseRel(parent.path, relUnder(parent.path, p)), comicRating);
    if (parent) throw new BadRequestError(`已经包含在「${parent.path}」里了，不用单独添加。要把它当漫画，选「漫画 · 跳过识别」再添加`);
    const d = normalizeRootPath(this.ctx.dataDir);
    if (samePath(p, d) || isInside(p, d) || isInside(d, p)) throw new BadRequestError('不能把 Emaki 的数据目录加入图库');

    // 新文件夹包含已有的文件夹：问一下再合并。以前移除过的子文件夹直接接管，找回当时的整理结果
    const children = rows.filter((r) => isInside(r.path, p));
    const activeChildren = children.filter((r) => r.removed_at === null);
    if (activeChildren.length && !body.merge) {
      const names = activeChildren.map((r) => `「${r.path}」`).join('');
      const disabled = activeChildren.filter((r) => !r.enabled).map((r) => `「${r.path}」`);
      const comics = activeChildren.filter((r) => r.content_mode === 'comic').map((r) => `「${r.path}」`);
      throw new NeedsConfirmError(
        `这个文件夹包含图库里已有的${names}，合并成一个吗？原来的识别和整理结果都会保留。` +
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

    const removed = rows.find((r) => r.removed_at !== null && samePath(r.path, p));
    let rootId = 0;
    let merged = 0;
    db.transaction(() => {
      if (removed) {
        // 复活：旧图和识别结果全部回来
        db.prepare('UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(
          p,
          mode,
          comicRating,
          removed.id,
        );
        rootId = removed.id;
      } else {
        rootId = Number(
          db.prepare('INSERT INTO library_roots (path, enabled, content_mode, comic_rating) VALUES (?, 1, ?, ?)').run(p, mode, comicRating).lastInsertRowid,
        );
      }
      if (children.length) merged = mergeChildRoots(db, rootId, p, children).images;
      // 复活、合并进来的旧图按这次的设置重判类型（按漫画导入：归漫画、用选的分级）
      if (removed || children.length) this.applyRootMode(rootId);
    })();
    if (children.length || removed) this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    // 只扫新文件夹；扫描正在跑时也再排一次，别丢了这个请求
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
    return done(
      activeChildren.length
        ? `已合并成一个文件夹（保留了 ${merged} 张图的整理结果），开始扫描其余部分：${p}`
        : mode === 'comic'
          ? `已按漫画导入，开始扫描（不识别，每个子文件夹成一本）：${p}`
          : `已添加文件夹，开始扫描：${p}`,
    );
  }

  /** 按图库文件夹的设置重判这个文件夹里所有图的类型；按漫画导入的，没识别过、没手动改过分级的页用选的分级。在事务里调用 */
  private applyRootMode(rootId: number, relDir?: string): number[] {
    const ids = this.imagesUnder(rootId, relDir);
    if (ids.length) syncRootModes(this.ctx.db, ids);
    return ids;
  }

  /** 图库文件夹里（relDir 给了就是这个子文件夹里）的全部图 */
  private imagesUnder(rootId: number, relDir?: string): number[] {
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    return this.ctx.db.prepare(`SELECT id FROM images WHERE root_id = @root ${under}`).pluck().all({ root: rootId, dir: relDir ?? '' }) as number[];
  }

  /**
   * 图库文件夹里的子文件夹按漫画导入（rating = null：不再按漫画导入）；可撤销。
   * 里面的图按新设置重判类型和分级，合集在事务之后重算；不再按漫画导入时没识别过的图接着识别
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
    const result = this.ctx.mutate((u) => {
      u.set('comic_folders', 'root_id = ? AND rel_dir = ?', [root.id, relDir]);
      if (rating === null) db.prepare('DELETE FROM comic_folders WHERE root_id = ? AND rel_dir = ?').run(root.id, relDir);
      else
        db.prepare(
          'INSERT INTO comic_folders (root_id, rel_dir, comic_rating, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(root_id, rel_dir) DO UPDATE SET comic_rating = excluded.comic_rating',
        ).run(root.id, relDir, rating, iso(this.ctx.clock()));
      this.applyRootMode(root.id, relDir);
      u.onUndo(() => {
        if (snap.length) this.restoreRootImages(root.id, snap, relDir);
        this.collectionsHook(null, 'all');
        this.ctx.touch();
        this.notifyRoots();
        // 撤销「按漫画导入」：回到插画，没识别过的接着识别
        if (rating !== null && !cur) this.requestTag();
      });
      const message =
        rating === null
          ? `「${where}」不再按漫画导入：没识别过的图会开始识别`
          : cur
            ? `「${where}」的分级改成了「${RATING_LABEL[rating]}」`
            : `已把「${where}」按漫画导入：${snap.length} 张归到漫画，不再识别`;
      return { message };
    });
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    if (rating === null) this.requestTag();
    return result;
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
    const result = this.ctx.mutate((u) => {
      u.columns('library_roots', cols, [root.id]);
      db.prepare('UPDATE library_roots SET enabled = ?, content_mode = ?, comic_rating = ? WHERE id = ?').run(enabled, mode, rating, root.id);
      if (touchesImages) this.applyRootMode(root.id);
      // 撤销时先由上面的 columns 恢复文件夹设置，再恢复图片、重算合集、同步监听、需要的话接着识别
      u.onUndo(() => {
        if (snap.length) this.restoreRootImages(root.id, snap);
        this.collectionsHook(null, 'all');
        this.ctx.touch();
        this.notifyRoots();
        // 撤销「改成漫画」回到插画：没识别过的图接着识别
        if (modeChanged && cur.content_mode !== 'comic') this.requestTag();
      });
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
    // 合集在事务提交之后重算：放在 mutate 里会变成嵌套事务，大文件夹逐行写页码会卡几十秒
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    // 改回插画：没识别过的图接着识别（模型在、用户没暂停时；正在识别也再排一轮）
    if (modeChanged && mode === 'auto') this.requestTag();
    return result;
  }

  /**
   * 撤销切换导入方式时恢复这个文件夹的图：期间没重新识别过的行按快照写回（手动改过的类型、分级不动）；
   * 期间识别过的、新扫进来的行按现在（已经恢复）的设置重判，免得把新的识别结果盖回旧值
   */
  private restoreRootImages(rootId: number, snap: RootImageSnap[], relDir?: string): void {
    const db = this.ctx.db;
    const under = relDir ? "AND substr(rel_path, 1, length(@dir) + 1) = @dir || '/'" : '';
    transact(db, () => {
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
      syncRootModes(db, [...recompute, ...snap.map((x) => x.id)]);
    });
  }

  async removeLibraryRoot(id: ID): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const set = this.ctx.db.prepare('UPDATE library_roots SET removed_at = ? WHERE id = ?');
    set.run(iso(this.ctx.clock()), root.id);
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    return this.ctx.undo.result(`已移除文件夹（不会删除磁盘上的文件）：${root.path}`, () => {
      set.run(null, root.id);
      this.collectionsHook(null, 'all');
      this.ctx.touch();
      this.notifyRoots();
    });
  }

  // T07 后台任务
  async listJobs(): Promise<Job[]> {
    return this.ctx.jobs.list();
  }
  async startJob(kind: JobKind): Promise<Job> {
    if (kind === 'scan') this.requests.requestFull();
    // 用户手动点的：之前读不到、正在退避的图也马上重试（比如刚把移动硬盘插回去）
    if (kind === 'tag' || kind === 'artists') resetIoBackoff();
    this.pipeline.noteManualStart(kind);
    return this.ctx.jobs.enqueue(kind);
  }
  async cancelJob(id: ID): Promise<void> {
    // 排队中的任务被取消时 runner 不会执行，pipeline 收不到「被取消」：这里先记下暂停，免得识别一结束又排上
    const job = this.ctx.jobs.list().find((j) => j.id === id);
    if (job && (job.status === 'queued' || job.status === 'running')) this.pipeline.notePaused(job.kind);
    this.ctx.jobs.cancel(id);
  }

  // 撤销：执行 UndoStack 里记下的反向操作（T19 会加 ctx.mutate，自动记录反向操作）
  async undo(token: string): Promise<MutationResult> {
    return this.ctx.undo.run(token);
  }
}
