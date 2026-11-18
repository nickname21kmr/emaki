/**
 * 测试用的客户端（P6）：P6 删掉了 DataSource 接口，引擎（SqliteDataSource）只是装配类，所有操作都在命令 / 查询注册表里。
 * 引擎测试、契约测试经这里调用注册表——和 HTTP、MCP 是同一条路（输入校验、命令层的事务和撤销、operationId、审计、事件）。
 *
 * 旧的方法名（getImage、bulkImages …）只在这里映射成命令和查询，方便保留原来的断言；一个旧方法对几个命令的
 * （updateImage、bulkImages、acceptSuggestion(s)、bulkCollections）用 HTTP 兼容层同一套转换（src/http/compat.ts）。
 * 新写的测试直接用 run / ask（命令、查询的名字和输入）。
 *
 * 用法：import { SqliteDataSource } from '…/test/helpers/client.ts'，open 出来的就是带这些方法的引擎；
 * 已经打开的引擎（演示模式）用 withClient(engine)。
 */
import type {
  AddLibraryRootBody,
  Artist,
  BulkCollectionsBody,
  BulkImagesBody,
  Character,
  ChangeEntry,
  ChangeGroup,
  CollectionSummary,
  ContentKind,
  ContentKindSummary,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CreateCollectionBody,
  CreateExclusionBody,
  CustomCharacterMatch,
  DuplicateGroup,
  Exclusion,
  GetCharacterResponse,
  GetCollectionResponse,
  ID,
  ImageDetail,
  ImageItem,
  ImportImagesBody,
  ImportImagesResult,
  Job,
  JobKind,
  LibraryStats,
  LibrarySummary,
  ListCharactersQuery,
  ListCharactersResponse,
  ListCollectionsQuery,
  ListDuplicatesQuery,
  ListImagesQuery,
  ListUnrecognizedQuery,
  ListUnrecognizedResponse,
  ListWorksQuery,
  MoveImagesBody,
  MovePreview,
  MutationResult,
  Page,
  PromotableSuggestions,
  ReplaceImageBody,
  ReplaceImageResult,
  RetagResult,
  SearchHit,
  SearchQuery,
  Settings,
  SourceModePreview,
  StartJobBody,
  TagSuggestion,
  TagSuggestionsQuery,
  ThumbWidth,
  TopCharactersQuery,
  UndoTokenStatus,
  UnrecognizedSummary,
  UnrecognizedSummaryQuery,
  UpdateArtistLinksBody,
  UpdateCharacterBody,
  UpdateCollectionBody,
  UpdateImageBody,
  UpdateLibraryRootBody,
  UpdateSettingsBody,
  Work,
} from '@emaki/shared';
import type { CallOptions, Call } from '../../src/commands/registry.ts';
import { SqliteDataSource as Engine } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { openDemoEngine as openRealDemo, type DemoEngine as RealDemoEngine } from '../../src/demo/engine.ts';
import { HttpError } from '../../src/http/errors.ts';
import { acceptCall, bulkCollectionsCall, bulkImagesCall, updateImageCalls } from '../../src/http/compat.ts';
import type { FileResponse } from '../../src/infra/ports.ts';
import type { CharacterVerification } from '../../src/services/catalog/characterVerification.ts';

/** 查不到（404）时返回 null：和以前 get* 的约定一样 */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404 && err.code === 'not_found' && /^找不到/.test(err.message)) return null;
    throw err;
  }
}

export function client(e: Engine) {
  const r = e.registry;
  const ask = <T>(name: string, input: unknown = {}) => r.query<T>(name, input);
  const run = <T = MutationResult>(name: string, input: unknown = {}, opts?: CallOptions) => r.execute<T>(name, input, opts);
  const call = <T = MutationResult>(c: Call) => r.batch<T>([c]);
  return {
    /** 执行一个命令（名字、输入）——新写的测试用它 */
    run,
    /** 执行一个查询 */
    ask,

    importImages: (body: ImportImagesBody) => run<ImportImagesResult>('library.import', body),
    replaceImage: (id: ID, body: ReplaceImageBody) => run<ReplaceImageResult>('library.replace', { id, ...body }),
    getStats: () => ask<LibraryStats>('library.stats'),
    getSummary: () => ask<LibrarySummary>('library.summary'),
    listContentKinds: () => ask<ContentKindSummary[]>('library.contentKinds'),
    listWorks: (q: ListWorksQuery = {}) => ask<Work[]>('works.list', q),
    getWork: (id: ID) => orNull(ask<Work>('works.get', { id })),
    listCustomCharacterMatches: () => ask<CustomCharacterMatch[]>('characters.danbooruMatches'),
    listCharacters: (q: ListCharactersQuery = {}) => ask<ListCharactersResponse>('characters.list', q),
    topCharacters: (q: TopCharactersQuery = {}) => ask<Character[]>('characters.top', q),
    getCharacter: (id: ID) => orNull(ask<GetCharacterResponse>('characters.get', { id })),
    createCharacter: (body: CreateCharacterBody) => run<MutationResult & { character: Character }>('catalog.createCharacter', body),
    updateCharacter: (id: ID, body: UpdateCharacterBody) => run('catalog.updateCharacter', { id, ...body }),
    markCharacterSeen: async (id: ID) => void (await run('catalog.markSeen', { id })),
    mergeCharacter: (id: ID, targetId: ID) => run('catalog.mergeCharacter', { id, targetId }),
    verifyCharacter: (body: CharacterVerification) => run('catalog.verifyCharacter', body),
    listCoverCandidates: (id: ID, limit: number) => ask<CoverCandidatesResponse>('characters.coverCandidates', { id, limit }),
    listCollections: (q: ListCollectionsQuery = {}) => ask<CollectionSummary[]>('collections.list', q),
    listArtists: () => ask<Artist[]>('artists.list'),
    updateArtistLinks: (body: UpdateArtistLinksBody) => run('catalog.linkArtists', body),
    getCollection: (id: ID) => orNull(ask<GetCollectionResponse>('collections.get', { id })),
    createCollection: (body: CreateCollectionBody) => run<MutationResult & { collection: CollectionSummary }>('collections.create', body),
    updateCollection: (id: ID, body: UpdateCollectionBody) => run('collections.update', { id, ...body }),
    deleteCollection: (id: ID) => run('collections.dissolve', { id }),
    bulkCollections: (body: BulkCollectionsBody) => call(bulkCollectionsCall(body)),
    listImages: (q: ListImagesQuery = {}) => ask<Page<ImageItem>>('images.list', q),
    getImage: (id: ID) => orNull(ask<ImageDetail>('images.get', { id })),
    updateImage: (id: ID, body: UpdateImageBody) => r.batch<MutationResult>(updateImageCalls(id, body)),
    bulkImages: (body: BulkImagesBody) => call(bulkImagesCall(body)),
    moveImages: (body: MoveImagesBody) => run('library.move', body),
    previewMove: (body: MoveImagesBody) => ask<MovePreview>('images.movePreview', body),
    getThumbnail: (id: ID, width: ThumbWidth) => orNull(ask<FileResponse>('images.thumbnail', { id, w: width })),
    getOriginal: (id: ID) => orNull(ask<FileResponse>('images.original', { id })),
    revealImage: async (id: ID) => void (await run('library.reveal', { id })),
    listUnrecognized: (q: ListUnrecognizedQuery = {}) => ask<ListUnrecognizedResponse>('unrecognized.list', q),
    unrecognizedSummary: (q: UnrecognizedSummaryQuery = {}) => ask<UnrecognizedSummary>('unrecognized.summary', q),
    retagUnrecognized: () => run<RetagResult>('unrecognized.retag'),
    acceptSuggestion: (imageId: ID, danbooruTag: string) => call(acceptCall(imageId, { danbooruTag })),
    acceptSuggestions: (imageId: ID, danbooruTags: string[]) => call(acceptCall(imageId, { danbooruTags })),
    listDuplicates: (q: ListDuplicatesQuery = {}) => ask<DuplicateGroup[]>('duplicates.list', q),
    resolveDuplicate: (id: ID, keepIds: ID[], batch?: string) => run('duplicates.resolve', { id, keepIds, batch }),
    ignoreDuplicate: (id: ID) => run('duplicates.ignore', { id }),
    listExclusions: () => ask<Exclusion[]>('exclusions.list'),
    createExclusion: (body: CreateExclusionBody) => run('visibility.createRule', body),
    deleteExclusion: (id: ID) => run('visibility.deleteRule', { id }),
    search: (q: SearchQuery) => ask<SearchHit[]>('search.all', q),
    tagSuggestions: (q: TagSuggestionsQuery) => ask<TagSuggestion[]>('search.tags', q),
    getSettings: () => ask<Settings>('settings.get'),
    updateSettings: (body: UpdateSettingsBody) => run<Settings>('settings.update', body),
    previewSourceMode: (mode: 'strict' | 'broad') => ask<SourceModePreview>('settings.sourceModePreview', { mode }),
    setSourceMode: (mode: 'strict' | 'broad') => run('settings.setSourceMode', { mode }),
    promotableSuggestions: (kind?: ContentKind) => ask<PromotableSuggestions>('settings.promotable', { kind }),
    promoteSuggestions: (kind?: ContentKind) => run('curation.promote', { kind }),
    addLibraryRoot: (body: AddLibraryRootBody) => run('library.addRoot', body),
    updateLibraryRoot: (id: ID, body: UpdateLibraryRootBody) => run('library.updateRoot', { id, ...body }),
    removeLibraryRoot: (id: ID) => run('library.removeRoot', { id }),
    listJobs: () => ask<Job[]>('jobs.list'),
    startJob: (kind: JobKind, options: Pick<StartJobBody, 'refreshPixiv'> = {}) => run<Job>('jobs.start', { kind, ...options }),
    cancelJob: async (id: ID) => void (await run('jobs.cancel', { id })),
    listChanges: (group: ChangeGroup) => ask<ChangeEntry[]>('changes.list', { group }),
    revertChange: (id: ID) => run('history.revertChange', { id }),
    undo: (token: string) => run('history.undo', { token }),
    undoStatus: async (tokens: string[]) => (await ask<{ status: Record<string, UndoTokenStatus> }>('history.undoStatus', { tokens })).status,
  };
}

export type Client = ReturnType<typeof client>;
/** 带客户端方法的引擎 */
export type TestEngine = Engine & Client;

/** 已经打开的引擎加上客户端方法（引擎本身的字段、方法照常可用） */
export function withClient(e: Engine): TestEngine {
  const c = client(e) as Record<string | symbol, unknown>;
  return new Proxy(e, {
    get: (target, key) => (Object.hasOwn(c, key) ? c[key] : Reflect.get(target, key, target)),
  }) as TestEngine;
}

/** 测试里替代引擎类：open 出来的是带客户端方法的引擎 */
export const SqliteDataSource = {
  open: async (...args: Parameters<typeof Engine.open>): Promise<TestEngine> => withClient(await Engine.open(...args)),
};
export type SqliteDataSource = TestEngine;
export type { SqliteOpenOptions } from '../../src/datasource/sqlite/SqliteDataSource.ts';

/** 演示引擎（demo/engine.ts）加上客户端方法 */
export type DemoEngine = Omit<RealDemoEngine, 'ds'> & { ds: TestEngine };
export async function openDemoEngine(...args: Parameters<typeof openRealDemo>): Promise<DemoEngine> {
  const demo = await openRealDemo(...args);
  return { ...demo, ds: withClient(demo.ds) };
}
