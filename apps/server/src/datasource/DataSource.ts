import type {
  AddLibraryRootBody,
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
  CreateExclusionBody,
  DuplicateGroup,
  Exclusion,
  GetCharacterResponse,
  ID,
  ImageDetail,
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
  Work,
} from '@emaki/shared';

/** 图片文件响应：要么直接给内容（mock 的 SVG），要么给磁盘路径让 fastify 流式发送。 */
export type FileResponse =
  | { kind: 'buffer'; contentType: string; body: Buffer | string; etag?: string; cacheControl?: string }
  | { kind: 'path'; contentType: string; filePath: string; etag?: string; cacheControl?: string };

/**
 * 数据层接口 —— 后端架构的核心接缝。
 *
 * routes/ 只依赖这个接口，不关心数据从哪来：
 * - MockDataSource（datasource/mock）：内存假数据，前端开发和演示用，已完整实现。
 * - SqliteDataSource（datasource/sqlite）：真实实现，读写 SQLite + 文件系统，逐项实现见 docs/TASKS.md。
 *
 * 约定：
 * - 找不到资源时 get* 返回 null，其余方法抛 NotFoundError。
 * - 所有修改方法返回 MutationResult，可撤销的带 undoToken（用 UndoStack.result）。
 * - 修改后要 emit `library-changed`，让前端刷新。
 */
export interface DataSource {
  // 统计
  getStats(): Promise<LibraryStats>;
  /** 别册首页：每一类的张数、最近张数和预览（T27） */
  listContentKinds(): Promise<ContentKindSummary[]>;

  // 作品
  listWorks(query: ListWorksQuery): Promise<Work[]>;
  getWork(id: ID): Promise<Work | null>;

  // 角色
  listCharacters(query: ListCharactersQuery): Promise<ListCharactersResponse>;
  topCharacters(query: TopCharactersQuery): Promise<Character[]>;
  getCharacter(id: ID): Promise<GetCharacterResponse | null>;
  createCharacter(body: CreateCharacterBody): Promise<MutationResult & { character: Character }>;
  updateCharacter(id: ID, body: UpdateCharacterBody): Promise<MutationResult>;
  markCharacterSeen(id: ID): Promise<void>;
  mergeCharacter(id: ID, targetId: ID): Promise<MutationResult>;
  /** 「换封面」候选（CB-7）：自动封面的排序，前 limit 张；角色不存在抛 NotFoundError */
  listCoverCandidates(id: ID, limit: number): Promise<CoverCandidatesResponse>;

  // 合集（T38c）
  listCollections(query: ListCollectionsQuery): Promise<CollectionSummary[]>;
  /** 识别出来的画师（认不出的不在里面），按张数从多到少 */
  listArtists(): Promise<Artist[]>;
  getCollection(id: ID): Promise<GetCollectionResponse | null>;
  createCollection(body: CreateCollectionBody): Promise<MutationResult & { collection: CollectionSummary }>;
  updateCollection(id: ID, body: UpdateCollectionBody): Promise<MutationResult>;
  /** 不成册 */
  deleteCollection(id: ID): Promise<MutationResult>;
  bulkCollections(body: BulkCollectionsBody): Promise<MutationResult>;

  // 图片
  listImages(query: ListImagesQuery): Promise<Page<ImageItem>>;
  getImage(id: ID): Promise<ImageDetail | null>;
  updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult>;
  bulkImages(body: BulkImagesBody): Promise<MutationResult>;
  /** 移到图库里的某个文件夹（真的移动文件），可撤销 */
  moveImages(body: MoveImagesBody): Promise<MutationResult>;
  getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null>;
  getOriginal(id: ID): Promise<FileResponse | null>;
  revealImage(id: ID): Promise<void>;

  // 未识别
  listUnrecognized(query: ListUnrecognizedQuery): Promise<ListUnrecognizedResponse>;
  /** 未识别两个大类、四个分段、各主题 / 各类的张数（T34a） */
  unrecognizedSummary(): Promise<UnrecognizedSummary>;
  /** 未识别里识别过、没认出角色、没放下的插画全部标记为重新识别，并启动识别任务 */
  retagUnrecognized(): Promise<RetagResult>;
  acceptSuggestion(imageId: ID, danbooruTag: string): Promise<MutationResult>;

  // 重复
  listDuplicates(query: ListDuplicatesQuery): Promise<DuplicateGroup[]>;
  resolveDuplicate(id: ID, keepIds: ID[]): Promise<MutationResult>;
  ignoreDuplicate(id: ID): Promise<MutationResult>;

  // 排除
  listExclusions(): Promise<Exclusion[]>;
  createExclusion(body: CreateExclusionBody): Promise<MutationResult>;
  deleteExclusion(id: ID): Promise<MutationResult>;

  // 搜索
  search(query: SearchQuery): Promise<SearchHit[]>;
  /** 一般标签联想（自定义画面） */
  tagSuggestions(query: TagSuggestionsQuery): Promise<TagSuggestion[]>;

  // 设置
  getSettings(): Promise<Settings>;
  updateSettings(body: UpdateSettingsBody): Promise<Settings>;
  addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult>;
  updateLibraryRoot(id: ID, enabled: boolean): Promise<MutationResult>;
  removeLibraryRoot(id: ID): Promise<MutationResult>;

  // 后台任务
  listJobs(): Promise<Job[]>;
  startJob(kind: JobKind): Promise<Job>;
  cancelJob(id: ID): Promise<void>;

  // 撤销
  undo(token: string): Promise<MutationResult>;

  /** 关闭数据库等资源（进程退出时调用） */
  close?(): Promise<void>;
}
