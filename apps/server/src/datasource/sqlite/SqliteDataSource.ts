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
  UnrecognizedSummary,
  UnrecognizedSummaryQuery,
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
  UpdateLibraryRootBody,
  UpdateArtistLinksBody,
  Work,
  PromotableSuggestions,
  ChangeEntry,
  ChangeGroup,
  MovePreview,
  SourceModePreview,
} from '@emaki/shared';
import path from 'node:path';
import type { EventBus } from '../../core/events.ts';
import { JobQueue } from '../../core/jobs.ts';
import { UndoStack } from '../../core/undo.ts';
import { closeDatabase, type Db } from '../../db/connection.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { SoftCache } from './softCache.ts';
import { NotFoundError } from '../../http/errors.ts';
import type { DataSource, FileResponse } from '../DataSource.ts';
import { ThumbnailService } from '../../services/image/ThumbnailService.ts';
import { Pipeline } from '../../services/pipeline.ts';
import { Scanner } from '../../services/scan/Scanner.ts';
import { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { recomputeCustomMatches } from '../../services/danbooru/matcher.ts';
import { ChangeLog } from './changeLog.ts';
import { IN_COMIC } from '../../services/classify/comicAreas.ts';
import { CollectionService, type CollectionsHook } from '../../services/collections/CollectionService.ts';
import { shutdownTagger } from '../../services/tagger/client.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { LibraryWatcher, type WatchedRoot } from '../../services/watch/LibraryWatcher.ts';
import { listImages } from './queries/listImages.ts';
import { BulkOps } from './bulk.ts';
import { CollectionQueries } from './collections.ts';
import { type KindDeps } from './kinds.ts';
import { DuplicateQueries } from './duplicates.ts';
import { SearchQueries } from './search.ts';
import { DedupeService } from '../../services/dedupe/DedupeService.ts';
import type { TrashImpl } from '../../services/trash/recycleBin.ts';
import { PendingTrash } from './pendingTrash.ts';
import { CharacterMutations } from './characters.ts';
import { UnrecognizedQueries } from './unrecognized.ts';
import { createContext } from './context.ts';
import { Derived } from './derived.ts';
import { applyExclusionRules, ExclusionQueries } from './exclusions.ts';
import { LibraryQueries } from './library.ts';
import { LibraryRoots } from './libraryRoots.ts';
import { SettingsOps } from './settingsOps.ts';
import { MoveOps } from './moveOps.ts';
import { JobControls } from './jobControls.ts';
import { updateArtistLinks } from './artistLinks.ts';
import { ImageOps } from './imageOps.ts';
import { requireVisibleImages } from './guards.ts';
import { importImages } from './importImages.ts';
import { replaceImage } from './replaceImage.ts';
import { listArtists as listArtistsQuery } from './artists.ts';
import { patchSettingsInternal, readSettings } from './settings.ts';

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
  /** 替换「这个盘有没有回收站」的检查（测试用：夹具里的 D:/Pics 不一定存在） */
  checkRecyclable?: (rootPath: string) => Promise<void>;
}

/**
 * 真实数据源：SQLite（better-sqlite3）+ 文件系统。
 *
 * 实现顺序和每个方法的验收标准见 docs/TASKS.md，方法上的 T 编号就是任务编号。
 *
 * 依赖按 TASKS.md「关键技术决策」安装：T01 better-sqlite3、T03 sharp、T09 onnxruntime-node（精确锁定版本）；
 * 文件监听用 Node 自带的 fs.watch（不装 chokidar），相似查重用 MIH（不用 BK-tree）。
 */
export class SqliteDataSource implements DataSource {
  async replaceImage(id: ID, body: ReplaceImageBody): Promise<ReplaceImageResult> {
    return replaceImage(this.ctx,id,body,ids=>{
      this.collectionsHook(null,ids);
      this.pipeline.afterImport();
    });
  }
  async importImages(body: ImportImagesBody): Promise<ImportImagesResult> {
    return importImages(this.ctx, body, {
      trashImpl: this.importTrashImpl,
      afterImport: (ids) => {
        this.collectionsHook(null, ids.length ? ids : 'all');
        if (ids.length) this.pipeline.afterImport();
      },
    });
  }
  private readonly importTrashImpl?: TrashImpl;
  /** 打开图库：见 open.ts（建库、迁移、启动回填、后台任务组装） */
  static async open(bus: EventBus, dataDir: string, opts: SqliteOpenOptions = {}): Promise<SqliteDataSource> {
    const { openSqliteDataSource } = await import('./open.ts');
    return openSqliteDataSource(bus, dataDir, opts);
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
  readonly characters: CharacterMutations;
  private readonly unrecognized: UnrecognizedQueries;
  private readonly bulk: BulkOps;
  /** 移到回收站的延后执行（最近几次可撤销） */
  readonly pendingTrash: PendingTrash;
  private readonly kindDeps: KindDeps;
  /** 合集（T38b） */
  readonly collections: CollectionService;
  /** 写操作之后重算合集；EMAKI_COLLECTIONS=0 时什么也不做 */
  private readonly collectionsHook: CollectionsHook = (undo, ids) => {
    if (process.env.EMAKI_COLLECTIONS === '0') return;
    const run = () => void (ids === 'all' ? this.collections.refreshAll() : this.collections.refreshDirs(ids));
    run();
    undo?.onUndoLast(run);
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
  /** 最近的改动：自动关联、Pixiv 补充、移动到文件夹（重启后也能撤回） */
  private readonly changes: ChangeLog;
  /** 图库文件夹（libraryRoots.ts） */
  readonly roots: LibraryRoots;
  /** 设置、Pixiv 识别方式、归建议（settingsOps.ts） */
  readonly settings: SettingsOps;
  /** 移动到文件夹（moveOps.ts） */
  private readonly moves: MoveOps;
  /** 单张图片（imageOps.ts） */
  private readonly images: ImageOps;
  /** 手动启动 / 取消后台任务（jobControls.ts） */
  private readonly jobControls: JobControls;

  /** 只创建各模块；外部用 SqliteDataSource.open() */
  constructor(db: Db, bus: EventBus, dataDir: string, opts: SqliteOpenOptions) {
    this.importTrashImpl = opts.trashImpl;
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
    this.pendingTrash = new PendingTrash(this.ctx, { trashImpl: opts.trashImpl, checkRoot: opts.checkRecyclable });
    this.bulk = new BulkOps(this.ctx, (ids) => requireVisibleImages(this.ctx, ids), this.kindDeps, this.pendingTrash, this.collectionsHook);
    this.unrecognized = new UnrecognizedQueries(this.ctx, () => this.makeCatalog().catalog, softMs);
    this.characters = new CharacterMutations(this.ctx, this.derived, () => this.danbooru, () => this.makeCatalog().catalog);
    this.exclusions = new ExclusionQueries(this.ctx, this.collectionsHook);
    this.changes = new ChangeLog(this.ctx, {
      collectionsHook: this.collectionsHook,
      recomputeCustomMatches: (ids) => recomputeCustomMatches(db, this.danbooru, ids),
    });
    this.roots = new LibraryRoots(this.ctx, this.requests, this.pipeline, this.collectionsHook, () => this.requestTag());
    this.settings = new SettingsOps(this.ctx, this.pipeline, this.roots, this.kindDeps, this.collectionsHook, () => this.makeCatalog);
    this.moves = new MoveOps(this.ctx, this.roots, this.changes);
    this.jobControls = new JobControls(this.ctx, this.requests, this.pipeline);
    this.images = new ImageOps(this.ctx, this.thumbs, this.kindDeps, this.collectionsHook, this.collections, () => this.makeCatalog);
    this.duplicates = new DuplicateQueries(this.ctx, this.pendingTrash, this.collectionsHook);
    this.searchQueries = new SearchQueries(db, this.derived);
    this.dedupe = new DedupeService({
      db,
      clock: this.ctx.clock,
      getThreshold: () => readSettings(db).dedupe.hammingThreshold,
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
        this.searchQueries.markStale();
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
  autoTag = true;
  private requestTag(): void {
    if (this.autoTag) this.pipeline.requestTag();
  }


  private watchedRoots(): WatchedRoot[] {
    return (this.ctx.db.prepare('SELECT id, path FROM library_roots WHERE enabled = 1 AND removed_at IS NULL').all() as { id: number; path: string }[]).map(
      (r) => ({ ...r, enabled: true }),
    );
  }

  startWatching(): void {
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
    // 还能撤销的回收站操作：退出前真的移进系统回收站
    await this.pendingTrash.flushAll();
    await shutdownTagger(); // 关掉推理子进程，释放显存
    clearInterval(this.optimizeTimer);
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
    return updateArtistLinks(this.ctx, body);
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
  async listCustomCharacterMatches(): Promise<CustomCharacterMatch[]> {
    return this.characters.customMatches();
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
  async listImages(query: ListImagesQuery): Promise<Page<ImageItem>> {
    return listImages(this.ctx.db, query, (key, compute) => this.results.get('count:' + key, compute) as number);
  }

  async getImage(id: ID): Promise<ImageDetail | null> {
    return this.images.getImage(id);
  }

  async updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult> {
    return this.images.updateImage(id, body);
  }

  async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
    return this.images.getThumbnail(id, width);
  }

  async getOriginal(id: ID): Promise<FileResponse | null> {
    return this.images.getOriginal(id);
  }

  async revealImage(id: ID): Promise<void> {
    return this.images.revealImage(id);
  }

  // T18 批量操作 / 回收站
  async bulkImages(body: BulkImagesBody): Promise<MutationResult> {
    const r = await this.bulk.run(body);
    // 画师改回自动：能自动续补时马上重新认这几张（用户暂停过补跑就不拉起来）
    if (body.action.type === 'artist-auto') this.pipeline.requestArtists();
    return r;
  }

  async previewMove(body: MoveImagesBody): Promise<MovePreview> {
    return this.moves.previewMove(body);
  }

  async moveImages(body: MoveImagesBody): Promise<MutationResult> {
    return this.moves.moveImages(body);
  }

  // 最近的改动（自动关联、Pixiv 补充、移动到文件夹）
  async listChanges(group: ChangeGroup): Promise<ChangeEntry[]> {
    return this.changes.list(group);
  }
  async revertChange(id: ID): Promise<MutationResult> {
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
    return this.searchQueries.search(query);
  }

  // T02 设置 / 图库文件夹
  /** 图库文件夹增删启停（T08 据此调整监听） */
  onRootsChanged(fn: () => void): () => void {
    return this.roots.onRootsChanged(fn);
  }

  /** 启动时清理移除超过 30 天的文件夹 */
  purgeRemovedRoots(): void {
    this.roots.purgeRemovedRoots();
  }

  async getSettings(): Promise<Settings> {
    return this.settings.getSettings();
  }

  async previewSourceMode(mode: 'strict' | 'broad'): Promise<SourceModePreview> {
    return this.settings.previewSourceMode(mode);
  }

  async setSourceMode(mode: 'strict' | 'broad'): Promise<MutationResult> {
    return this.settings.setSourceMode(mode);
  }

  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    return this.settings.updateSettings(body);
  }

  async promotableSuggestions(): Promise<PromotableSuggestions> {
    return this.settings.promotableSuggestions();
  }

  async promoteSuggestions(): Promise<MutationResult> {
    return this.settings.promoteSuggestions();
  }

  async addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult> {
    return this.roots.addLibraryRoot(body);
  }

  async updateLibraryRoot(id: ID, body: UpdateLibraryRootBody): Promise<MutationResult> {
    return this.roots.updateLibraryRoot(id, body);
  }

  async removeLibraryRoot(id: ID): Promise<MutationResult> {
    return this.roots.removeLibraryRoot(id);
  }

  // T07 后台任务
  async listJobs(): Promise<Job[]> {
    return this.jobControls.list();
  }
  async startJob(kind: JobKind, options: Pick<StartJobBody, 'refreshPixiv'> = {}): Promise<Job> {
    return this.jobControls.start(kind, options);
  }
  async cancelJob(id: ID): Promise<void> {
    this.jobControls.cancel(id);
  }

  // 撤销：执行 UndoStack 里记下的反向操作（T19 会加 ctx.mutate，自动记录反向操作）
  async undo(token: string): Promise<MutationResult> {
    return this.ctx.undo.run(token);
  }

  async undoStatus(tokens: string[]): Promise<Record<string, UndoTokenStatus>> {
    return Object.fromEntries(tokens.map((t) => [t, this.ctx.undo.status(t)]));
  }
}
