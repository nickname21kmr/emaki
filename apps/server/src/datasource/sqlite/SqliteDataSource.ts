import type {
  AddLibraryRootBody,
  BulkCollectionsBody,
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
  MutationResult,
  Page,
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
  Work,
} from '@emaki/shared';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EventBus } from '../../core/events.ts';
import { JobQueue } from '../../core/jobs.ts';
import { done, UndoStack } from '../../core/undo.ts';
import { closeDatabase, openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { refreshPlannerStats } from '../../db/plannerStats.ts';
import { SoftCache } from './softCache.ts';
import { consolidateCharacterTags } from './consolidate.ts';
import { BadRequestError, NotFoundError, NotImplementedError } from '../../http/errors.ts';
import type { DataSource, FileResponse } from '../DataSource.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { revealInFileManager } from '../../services/fs/reveal.ts';
import { ThumbnailService, type ThumbRow } from '../../services/image/ThumbnailService.ts';
import { Pipeline } from '../../services/pipeline.ts';
import { Scanner } from '../../services/scan/Scanner.ts';
import { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { backfillSources } from '../../services/source/backfill.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { CollectionService, type CollectionsHook } from '../../services/collections/CollectionService.ts';
import { shutdownTagger } from '../../services/tagger/client.ts';
import { createTagStage } from '../../services/tagger/tagJob.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import { CopyrightResolver } from '../../services/catalog/copyrights.ts';
import { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { createDanbooruSyncRunner, hasUncachedCharacterTags } from '../../services/danbooru/sync.ts';
import { importDictIfNeeded } from '../../services/i18n/dict.ts';
import { SqliteLocalizer, type Localizer } from '../../services/i18n/localizer.ts';
import { relocalizeAll } from '../../services/i18n/relocalize.ts';
import { LibraryWatcher, type WatchedRoot } from '../../services/watch/LibraryWatcher.ts';
import { config } from '../../config.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import { listImages } from './queries/listImages.ts';
import { loadSuggestions } from './suggestions.ts';
import { BulkOps } from './bulk.ts';
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
import { applySettingsPatch, getDanbooruApiKey, isInside, normalizeRootPath, patchSettingsInternal, readSettings, samePath } from './settings.ts';
import { iso, MIME, parseId, toId, VISIBLE } from './sql.ts';

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
        shouldRunAfterTag: () => readSettings(db).danbooru.enabled && hasUncachedCharacterTags(db),
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
        if (s.added + s.updated + s.moved + s.missing + s.restored > 0) ds.refreshCollections('scan');
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
    };
  }

  /** 看图器「收录于」：pageNo 是可见页里的序号（RV-C-8） */
  private imageCollection(imageId: number): ImageDetail['collection'] {
    const r = this.ctx
      .stmt(
        `SELECT c.id, c.kind, c.title,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id AND x.page_no <= i.page_no) AS ord,
           (SELECT COUNT(*) FROM v_counted_images x WHERE x.collection_id = c.id) AS n
         FROM images i JOIN collections c ON c.id = i.collection_id WHERE i.id = ? AND c.state = 'active'`,
      )
      .get(imageId) as { id: number; kind: 'doujin' | 'artbook'; title: string | null; ord: number; n: number } | undefined;
    return r ? { id: toId(r.id), kind: r.kind, title: r.title, pageNo: Math.max(1, r.ord), pageCount: r.n } : null;
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
    return this.bulk.run(body);
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
        `SELECT r.id, r.path, r.enabled, r.last_scan_at, r.imported_at,
           (SELECT COUNT(*) FROM images i
             WHERE i.root_id = r.id AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL) AS image_count
         FROM library_roots r
         WHERE r.removed_at IS NULL
         ORDER BY r.id`,
      )
      .all() as { id: number; path: string; enabled: number; last_scan_at: string | null; imported_at: string | null; image_count: number }[];
    return {
      libraryRoots: rows.map((r) => ({
        id: toId(r.id),
        path: r.path,
        enabled: !!r.enabled,
        imageCount: r.image_count,
        lastScanAt: r.last_scan_at,
        importedAt: r.imported_at,
      })),
      ...readSettings(this.ctx.db),
    };
  }

  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    const before = readSettings(this.ctx.db).tagger.autoAcceptThreshold;
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
    const rows = db.prepare('SELECT id, path, removed_at FROM library_roots').all() as {
      id: number;
      path: string;
      removed_at: string | null;
    }[];
    const active = rows.filter((r) => r.removed_at === null);
    if (active.some((r) => samePath(r.path, p))) throw new BadRequestError('这个文件夹已经在图库里了');
    const overlap = active.find((r) => isInside(p, r.path) || isInside(r.path, p));
    if (overlap) throw new BadRequestError(`和已有文件夹重叠：${overlap.path}`);
    const d = normalizeRootPath(this.ctx.dataDir);
    if (samePath(p, d) || isInside(p, d) || isInside(d, p)) throw new BadRequestError('不能把 Emaki 的数据目录加入图库');

    const removed = rows.find((r) => r.removed_at !== null && samePath(r.path, p));
    let rootId: number;
    if (removed) {
      // 复活：旧图和识别结果全部回来
      db.prepare('UPDATE library_roots SET removed_at = NULL, enabled = 1, path = ? WHERE id = ?').run(p, removed.id);
      rootId = removed.id;
    } else {
      rootId = Number(db.prepare('INSERT INTO library_roots (path, enabled) VALUES (?, 1)').run(p).lastInsertRowid);
    }
    this.ctx.touch();
    this.notifyRoots();
    // 只扫新文件夹；扫描正在跑时也再排一次，别丢了这个请求
    this.requests.addDirty({ rootId, relDir: '', recursive: true });
    this.ctx.jobs.enqueue('scan', { requeueIfRunning: true });
    return done(`已添加文件夹，开始扫描：${p}`);
  }

  async updateLibraryRoot(id: ID, enabled: boolean): Promise<MutationResult> {
    const root = this.requireRoot(id);
    const set = this.ctx.db.prepare('UPDATE library_roots SET enabled = ? WHERE id = ?');
    set.run(enabled ? 1 : 0, root.id);
    this.collectionsHook(null, 'all');
    this.ctx.touch();
    this.notifyRoots();
    return this.ctx.undo.result(enabled ? `已启用：${root.path}` : `已停用：${root.path}`, () => {
      set.run(root.enabled, root.id);
      this.collectionsHook(null, 'all');
      this.ctx.touch();
      this.notifyRoots();
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
    this.pipeline.noteManualStart(kind);
    return this.ctx.jobs.enqueue(kind);
  }
  async cancelJob(id: ID): Promise<void> {
    this.ctx.jobs.cancel(id);
  }

  // 撤销：执行 UndoStack 里记下的反向操作（T19 会加 ctx.mutate，自动记录反向操作）
  async undo(token: string): Promise<MutationResult> {
    return this.ctx.undo.run(token);
  }
}
