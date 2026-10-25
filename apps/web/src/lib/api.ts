/**
 * 前端唯一的 HTTP 出口。页面组件不要直接 fetch，走 lib/queries.ts 里的 hook。
 * 接口定义见 packages/shared/src/api.ts。
 */
import type {
  AcceptSuggestionBody,
  UndoStatusResponse,
  AddLibraryRootBody,
  ApiError,
  BulkCollectionsBody,
  BulkImagesBody,
  CollectionSummary,
  CreateCollectionBody,
  GetCollectionResponse,
  ListCollectionsQuery,
  ListArtistsResponse,
  ListCollectionsResponse,
  UpdateCollectionBody,
  Character,
  CoverCandidatesQuery,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CustomCharacterMatch,
  CreateExclusionBody,
  GetCharacterResponse,
  GetImageResponse,
  GetSettingsResponse,
  GetStatsResponse,
  ID,
  ImportImagesBody,
  ImportImagesResult,
  ReplaceImageBody,
  ReplaceImageResult,
  Job,
  JobKind,
  StartJobBody,
  ListCharactersQuery,
  ListCharactersResponse,
  ListContentKindsResponse,
  ListDuplicatesQuery,
  ListDuplicatesResponse,
  ListExclusionsResponse,
  ListImagesQuery,
  ListImagesResponse,
  ListJobsResponse,
  ListTaggerModelsResponse,
  PromotableSuggestions,
  ListUnrecognizedQuery,
  ListUnrecognizedResponse,
  RetagResult,
  UnrecognizedSummary,
  UnrecognizedSummaryQuery,
  HealthResponse,
  MoveImagesBody,
  MovePreview,
  ChangeEntry,
  ChangeGroup,
  SourceModePreview,
  NetworkCheckResponse,
  PickFolderResponse,
  ListWorksQuery,
  ListWorksResponse,
  MutationResult,
  SearchResponse,
  TagSuggestionsResponse,
  Settings,
  TopCharactersQuery,
  TopCharactersResponse,
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
  UpdateLibraryRootBody,
  UpdateArtistLinksBody,
  Work,
} from '@emaki/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError['code'] | 'network',
    message: string,
  ) {
    super(message);
  }
}

type QueryValue = string | number | boolean | string[] | undefined | null;

function toQueryString(params?: object): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, QueryValue>)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) sp.set(key, value.join(','));
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, 'network', '连不上后端：可能正在重启，过几秒再试；一直这样的话，看看后端窗口是不是关了');
  }
  // 开发模式下 vite 代理连不上后端时回 502 / 503 / 504（后端重启要十几秒）：按「连不上」处理，查询会自动重试
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiRequestError(res.status, 'network', '后端暂时连不上（可能正在重启），过几秒再试一次');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = data as Partial<ApiError> | undefined;
    throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.error ?? `请求失败（${res.status}）`);
  }
  return data as T;
}

const get = <T>(path: string, params?: object) => request<T>('GET', `${path}${toQueryString(params)}`);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

/** 图片 URL（不走 fetch，直接给 <img src>） */
export const imageUrl = {
  thumb: (id: ID, width: 240 | 480 | 960 = 480, version?: string) => `/api/images/${encodeURIComponent(id)}/thumb?w=${width}${version ? `&v=${encodeURIComponent(version)}` : ''}`,
  file: (id: ID, version?: string) => `/api/images/${encodeURIComponent(id)}/file${version ? `?v=${encodeURIComponent(version)}` : ''}`,
};

export const api = {
  importImages: (body: ImportImagesBody) => post<ImportImagesResult>('/images/import',body),
  replaceImage: (id: ID, body: ReplaceImageBody) => post<ReplaceImageResult>(`/images/${encodeURIComponent(id)}/replace`,body),
  stats: () => get<GetStatsResponse>('/stats'),
  contentKinds: () => get<ListContentKindsResponse>('/content-kinds'),

  works: (q: ListWorksQuery = {}) => get<ListWorksResponse>('/works', q),
  work: (id: ID) => get<Work>(`/works/${encodeURIComponent(id)}`),

  customCharacterMatches: () => get<CustomCharacterMatch[]>('/characters/danbooru-matches'),
  characters: (q: ListCharactersQuery = {}) => get<ListCharactersResponse>('/characters', q),
  topCharacters: (q: TopCharactersQuery = {}) => get<TopCharactersResponse>('/characters/top', q),
  character: (id: ID) => get<GetCharacterResponse>(`/characters/${encodeURIComponent(id)}`),
  createCharacter: (body: CreateCharacterBody) =>
    post<MutationResult & { character: Character }>('/characters', body),
  updateCharacter: (id: ID, body: UpdateCharacterBody) =>
    patch<MutationResult>(`/characters/${encodeURIComponent(id)}`, body),
  /** 「换封面」候选（CB-7） */
  coverCandidates: (id: ID, q: CoverCandidatesQuery = {}) =>
    get<CoverCandidatesResponse>(`/characters/${encodeURIComponent(id)}/cover-candidates`, q),
  markCharacterSeen: (id: ID) => post<{ ok: true }>(`/characters/${encodeURIComponent(id)}/seen`),
  mergeCharacter: (id: ID, targetId: ID) =>
    post<MutationResult>(`/characters/${encodeURIComponent(id)}/merge`, { targetId }),

  images: (q: ListImagesQuery = {}) => get<ListImagesResponse>('/images', q),
  image: (id: ID) => get<GetImageResponse>(`/images/${encodeURIComponent(id)}`),
  updateImage: (id: ID, body: UpdateImageBody) => patch<MutationResult>(`/images/${encodeURIComponent(id)}`, body),
  bulkImages: (body: BulkImagesBody) => post<MutationResult>('/images/bulk', body),
  revealImage: (id: ID) => post<{ ok: true }>(`/images/${encodeURIComponent(id)}/reveal`),

  collections: (q: ListCollectionsQuery = {}) => get<ListCollectionsResponse>('/collections', q),
  artists: () => get<ListArtistsResponse>('/artists'),
  collection: (id: ID) => get<GetCollectionResponse>(`/collections/${encodeURIComponent(id)}`),
  createCollection: (body: CreateCollectionBody) => post<MutationResult & { collection: CollectionSummary }>('/collections', body),
  updateCollection: (id: ID, body: UpdateCollectionBody) => patch<MutationResult>(`/collections/${encodeURIComponent(id)}`, body),
  deleteCollection: (id: ID) => del<MutationResult>(`/collections/${encodeURIComponent(id)}`),
  bulkCollections: (body: BulkCollectionsBody) => post<MutationResult>('/collections/bulk', body),

  unrecognized: (q: ListUnrecognizedQuery = {}) => get<ListUnrecognizedResponse>('/unrecognized', q),
  unrecognizedSummary: (q: UnrecognizedSummaryQuery = {}) => get<UnrecognizedSummary>('/unrecognized/summary', q),
  retagUnrecognized: () => post<RetagResult>('/unrecognized/retag'),
  acceptSuggestion: (imageId: ID, body: AcceptSuggestionBody) =>
    post<MutationResult>(`/unrecognized/${encodeURIComponent(imageId)}/accept`, body),

  duplicates: (q: ListDuplicatesQuery = {}) => get<ListDuplicatesResponse>('/duplicates', q),
  /** batch：「全部处理」各组传同一个，在最近 5 次可撤销里只算一次 */
  resolveDuplicate: (id: ID, keepIds: ID[], batch?: string) =>
    post<MutationResult>(`/duplicates/${encodeURIComponent(id)}/resolve`, batch ? { keepIds, batch } : { keepIds }),
  ignoreDuplicate: (id: ID) => post<MutationResult>(`/duplicates/${encodeURIComponent(id)}/ignore`),

  exclusions: () => get<ListExclusionsResponse>('/exclusions'),
  createExclusion: (body: CreateExclusionBody) => post<MutationResult>('/exclusions', body),
  deleteExclusion: (id: ID) => del<MutationResult>(`/exclusions/${encodeURIComponent(id)}`),

  search: (q: string, limit = 20) => get<SearchResponse>('/search', { q, limit }),
  /** 一般标签联想（自定义画面）；q 为空 = 最常见的 */
  tags: (q: string, limit = 20) => get<TagSuggestionsResponse>('/tags', { q, limit }),

  settings: () => get<GetSettingsResponse>('/settings'),
  /** 可选的识别模型（设置页下拉框） */
  taggerModels: () => get<ListTaggerModelsResponse>('/tagger/models'),
  /** 已有建议里分数达到自动采纳阈值的（调低阈值后才会有） */
  promotableSuggestions: () => get<PromotableSuggestions>('/tagger/promotable'),
  /** 把达标的建议归到角色（可撤销） */
  promoteSuggestions: () => post<MutationResult>('/tagger/promote'),
  updateSettings: (body: UpdateSettingsBody) => put<Settings>('/settings', body),
  addLibraryRoot: (body: AddLibraryRootBody) => post<MutationResult>('/library-roots', body),
  updateArtistLinks: (body: UpdateArtistLinksBody) => post<MutationResult>('/artists/links', body),
  updateLibraryRoot: (id: ID, body: UpdateLibraryRootBody) => patch<MutationResult>(`/library-roots/${encodeURIComponent(id)}`, body),
  removeLibraryRoot: (id: ID) => del<MutationResult>(`/library-roots/${encodeURIComponent(id)}`),

  jobs: () => get<ListJobsResponse>('/jobs'),
  startJob: (kind: JobKind, options?: Pick<StartJobBody, 'refreshPixiv'>) => post<Job>('/jobs', { kind, ...options }),
  cancelJob: (id: ID) => del<{ ok: true }>(`/jobs/${encodeURIComponent(id)}`),

  undo: (token: string) => post<MutationResult>(`/undo/${encodeURIComponent(token)}`),
  undoStatus: (tokens: string[]) => post<UndoStatusResponse>('/undo/status', { tokens }),

  health: () => get<HealthResponse>('/health'),
  /** 由后端弹出系统「选择文件夹」对话框；用户取消时 path 为 null */
  pickFolder: () => post<PickFolderResponse>('/system/pick-folder'),
  /** 移到图库里的某个文件夹（磁盘上真的移动），可撤销 */
  moveImages: (body: MoveImagesBody) => post<MutationResult>('/images/move', body),
  /** 移动前先数：服务端会移哪些图（按角色移动时拿这里的 ids 再提交） */
  previewMove: (body: MoveImagesBody) => post<MovePreview>('/images/move/preview', body),
  /** 切换 Pixiv 投稿号识别方式：先数影响，再切换（可撤销） */
  previewSourceMode: (mode: 'strict' | 'broad') => get<SourceModePreview>(`/settings/source-mode?mode=${mode}`),
  setSourceMode: (mode: 'strict' | 'broad') => post<MutationResult>('/settings/source-mode', { mode }),
  /** 最近的改动（自动关联、Pixiv 补充 / 移动到文件夹），重启后也能撤回 */
  changes: (group: ChangeGroup) => get<ChangeEntry[]>(`/changes?group=${group}`),
  revertChange: (id: ID) => post<MutationResult>(`/changes/${encodeURIComponent(id)}/revert`),
  /** 连一下 Danbooru、Hugging Face 和国内镜像，排查同步失败 */
  checkNetwork: () => post<NetworkCheckResponse>('/system/network-check'),
};
