import type {
  AddLibraryRootBody,
  UpdateLibraryRootBody,
  UpdateArtistLinksBody,
  BulkCollectionsBody,
  Artist,
  BulkImagesBody,
  MoveImagesBody,
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
  MutationResult,
  UndoTokenStatus,
  Page,
  RetagResult,
  SearchHit,
  SearchQuery,
  TagSuggestion,
  TagSuggestionsQuery,
  PromotableSuggestions,
  Settings,
  ThumbWidth,
  TopCharactersQuery,
  UnrecognizedItem,
  UnrecognizedSummary,
  UnrecognizedSummaryQuery,
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
  Work,
  ChangeEntry,
  ChangeGroup,
  MovePreview,
  SourceModePreview,
} from '@emaki/shared';

/** 图片文件响应：要么直接给内容，要么给磁盘路径让 fastify 流式发送。 */
export type FileResponse =
  | { kind: 'buffer'; contentType: string; body: Buffer | string; etag?: string; cacheControl?: string }
  | { kind: 'path'; contentType: string; filePath: string; etag?: string; cacheControl?: string };

/**
 * 数据层接口 —— 路由和数据之间的接缝，按领域拆成几个小接口，每个路由文件只依赖自己用到的那几个。
 *
 * 实现是 SqliteDataSource（datasource/sqlite）：读写 SQLite + 文件系统。
 * 演示模式也用它，只是数据库换成导入了假数据的演示库（src/demo）。
 *
 * 约定：
 * - 找不到资源时 get* 返回 null，其余方法抛 NotFoundError。
 * - 所有修改方法返回 MutationResult，可撤销的带 undoToken（用 UndoStack.result）。
 * - 修改后要 emit `library-changed`，让前端刷新。
 */

/** 统计、别册汇总、作品、⌘K 搜索和标签联想（routes/library.ts） */
export interface LibraryData {
  getStats(): Promise<LibraryStats>;
  /** 别册首页：每一类的张数、最近张数和预览（T27） */
  listContentKinds(): Promise<ContentKindSummary[]>;
  listWorks(query: ListWorksQuery): Promise<Work[]>;
  getWork(id: ID): Promise<Work | null>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  /** 一般标签联想（自定义画面） */
  tagSuggestions(query: TagSuggestionsQuery): Promise<TagSuggestion[]>;
}

/** 角色：列表、详情、封面候选、新建 / 编辑 / 合并、自建角色的 Danbooru 关联（routes/library.ts） */
export interface CharacterData {
  listCustomCharacterMatches(): Promise<CustomCharacterMatch[]>;
  listCharacters(query: ListCharactersQuery): Promise<ListCharactersResponse>;
  topCharacters(query: TopCharactersQuery): Promise<Character[]>;
  getCharacter(id: ID): Promise<GetCharacterResponse | null>;
  createCharacter(body: CreateCharacterBody): Promise<MutationResult & { character: Character }>;
  updateCharacter(id: ID, body: UpdateCharacterBody): Promise<MutationResult>;
  markCharacterSeen(id: ID): Promise<void>;
  mergeCharacter(id: ID, targetId: ID): Promise<MutationResult>;
  /** 「换封面」候选（CB-7）：自动封面的排序，前 limit 张；角色不存在抛 NotFoundError */
  listCoverCandidates(id: ID, limit: number): Promise<CoverCandidatesResponse>;
}

/** 合集（T38c，routes/collections.ts） */
export interface CollectionData {
  listCollections(query: ListCollectionsQuery): Promise<CollectionSummary[]>;
  getCollection(id: ID): Promise<GetCollectionResponse | null>;
  createCollection(body: CreateCollectionBody): Promise<MutationResult & { collection: CollectionSummary }>;
  updateCollection(id: ID, body: UpdateCollectionBody): Promise<MutationResult>;
  /** 不成册 */
  deleteCollection(id: ID): Promise<MutationResult>;
  bulkCollections(body: BulkCollectionsBody): Promise<MutationResult>;
}

/** 画师（routes/collections.ts） */
export interface ArtistData {
  /** 识别出来的画师（认不出的不在里面），按张数从多到少 */
  listArtists(): Promise<Artist[]>;
  updateArtistLinks(body: UpdateArtistLinksBody): Promise<MutationResult>;
}

/** 图片：列表、详情、修改、批量、移动、入库 / 替换、文件（routes/images.ts） */
export interface ImageData {
  listImages(query: ListImagesQuery): Promise<Page<ImageItem>>;
  getImage(id: ID): Promise<ImageDetail | null>;
  updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult>;
  bulkImages(body: BulkImagesBody): Promise<MutationResult>;
  /** 移到图库里的某个文件夹（真的移动文件），可撤销 */
  moveImages(body: MoveImagesBody): Promise<MutationResult>;
  /** 移动前先数：会移哪些图、几张已经在那里、几张同时属于别的角色（只读） */
  previewMove(body: MoveImagesBody): Promise<MovePreview>;
  importImages(body: ImportImagesBody): Promise<ImportImagesResult>;
  replaceImage(id: ID, body: ReplaceImageBody): Promise<ReplaceImageResult>;
  getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null>;
  getOriginal(id: ID): Promise<FileResponse | null>;
  revealImage(id: ID): Promise<void>;
}

/** 未识别（routes/images.ts） */
export interface UnrecognizedData {
  listUnrecognized(query: ListUnrecognizedQuery): Promise<ListUnrecognizedResponse>;
  /** 未识别两个大类、四个分段、各主题 / 各类的张数（T34a）；artKind 只算插画或漫画 */
  unrecognizedSummary(query?: UnrecognizedSummaryQuery): Promise<UnrecognizedSummary>;
  /** 未识别里识别过、没认出角色、没放下的插画全部标记为重新识别，并启动识别任务 */
  retagUnrecognized(): Promise<RetagResult>;
  acceptSuggestion(imageId: ID, danbooruTag: string): Promise<MutationResult>;
  /** 同一张图一次采纳多条建议，一条撤销 */
  acceptSuggestions(imageId: ID, danbooruTags: string[]): Promise<MutationResult>;
}

/** 重复（routes/images.ts） */
export interface DuplicateData {
  listDuplicates(query: ListDuplicatesQuery): Promise<DuplicateGroup[]>;
  /** 移到回收站的最近 5 次可撤销；batch 相同的几次（「全部处理」）只算一次 */
  resolveDuplicate(id: ID, keepIds: ID[], batch?: string): Promise<MutationResult>;
  ignoreDuplicate(id: ID): Promise<MutationResult>;
}

/** 排除规则（routes/images.ts） */
export interface ExclusionData {
  listExclusions(): Promise<Exclusion[]>;
  createExclusion(body: CreateExclusionBody): Promise<MutationResult>;
  deleteExclusion(id: ID): Promise<MutationResult>;
}

/** 设置、Pixiv 识别方式、归建议、图库文件夹（routes/system.ts） */
export interface SettingsData {
  getSettings(): Promise<Settings>;
  updateSettings(body: UpdateSettingsBody): Promise<Settings>;
  /** 切换 Pixiv 投稿号识别方式前先数影响（只读） */
  previewSourceMode(mode: 'strict' | 'broad'): Promise<SourceModePreview>;
  /** 切换 Pixiv 投稿号识别方式：报告影响了多少张，可撤销 */
  setSourceMode(mode: 'strict' | 'broad'): Promise<MutationResult>;
  /** 已有建议里分数达到自动采纳阈值的（调低阈值后才会有；保存设置时不自动归） */
  promotableSuggestions(): Promise<PromotableSuggestions>;
  /** 把达标的建议归到角色，可撤销 */
  promoteSuggestions(): Promise<MutationResult>;
  addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult>;
  updateLibraryRoot(id: ID, body: UpdateLibraryRootBody): Promise<MutationResult>;
  removeLibraryRoot(id: ID): Promise<MutationResult>;
}

/** 后台任务、最近的改动（重启后也能撤回）、撤销（routes/system.ts） */
export interface JobData {
  listJobs(): Promise<Job[]>;
  startJob(kind: JobKind, options?: Pick<StartJobBody, 'refreshPixiv'>): Promise<Job>;
  cancelJob(id: ID): Promise<void>;
  listChanges(group: ChangeGroup): Promise<ChangeEntry[]>;
  revertChange(id: ID): Promise<MutationResult>;
  undo(token: string): Promise<MutationResult>;
  /** 一批撤销 token 现在的状态（只读） */
  undoStatus(tokens: string[]): Promise<Record<string, UndoTokenStatus>>;
}

/** 全部数据接口：应用启动时组装好交给路由 */
export interface DataSource
  extends LibraryData,
    CharacterData,
    CollectionData,
    ArtistData,
    ImageData,
    UnrecognizedData,
    DuplicateData,
    ExclusionData,
    SettingsData,
    JobData {
  /** 关闭数据库等资源（进程退出时调用） */
  close?(): Promise<void>;
}
