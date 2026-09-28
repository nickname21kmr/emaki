/**
 * 前端唯一的 HTTP 出口。页面组件不要直接 fetch，走 lib/queries.ts 里的 hook。
 * 接口定义见 packages/shared/src/api.ts。
 */
import type {
  AcceptSuggestionBody,
  AddLibraryRootBody,
  ApiError,
  BulkCollectionsBody,
  BulkImagesBody,
  CollectionSummary,
  CreateCollectionBody,
  GetCollectionResponse,
  ListCollectionsQuery,
  ListCollectionsResponse,
  UpdateCollectionBody,
  Character,
  CoverCandidatesQuery,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CreateExclusionBody,
  GetCharacterResponse,
  GetImageResponse,
  GetSettingsResponse,
  GetStatsResponse,
  ID,
  Job,
  JobKind,
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
  ListUnrecognizedQuery,
  ListUnrecognizedResponse,
  UnrecognizedSummary,
  HealthResponse,
  PickFolderResponse,
  ListWorksQuery,
  ListWorksResponse,
  MutationResult,
  SearchResponse,
  Settings,
  TopCharactersQuery,
  TopCharactersResponse,
  UpdateCharacterBody,
  UpdateImageBody,
  UpdateSettingsBody,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError(0, 'network', '连不上后端，确认 `npm run dev` 正在运行');
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
  thumb: (id: ID, width: 240 | 480 | 960 = 480) => `/api/images/${encodeURIComponent(id)}/thumb?w=${width}`,
  file: (id: ID) => `/api/images/${encodeURIComponent(id)}/file`,
};

export const api = {
  stats: () => get<GetStatsResponse>('/stats'),
  contentKinds: () => get<ListContentKindsResponse>('/content-kinds'),

  works: (q: ListWorksQuery = {}) => get<ListWorksResponse>('/works', q),
  work: (id: ID) => get<Work>(`/works/${encodeURIComponent(id)}`),

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
  collection: (id: ID) => get<GetCollectionResponse>(`/collections/${encodeURIComponent(id)}`),
  createCollection: (body: CreateCollectionBody) => post<MutationResult & { collection: CollectionSummary }>('/collections', body),
  updateCollection: (id: ID, body: UpdateCollectionBody) => patch<MutationResult>(`/collections/${encodeURIComponent(id)}`, body),
  deleteCollection: (id: ID) => del<MutationResult>(`/collections/${encodeURIComponent(id)}`),
  bulkCollections: (body: BulkCollectionsBody) => post<MutationResult>('/collections/bulk', body),

  unrecognized: (q: ListUnrecognizedQuery = {}) => get<ListUnrecognizedResponse>('/unrecognized', q),
  unrecognizedSummary: () => get<UnrecognizedSummary>('/unrecognized/summary'),
  acceptSuggestion: (imageId: ID, body: AcceptSuggestionBody) =>
    post<MutationResult>(`/unrecognized/${encodeURIComponent(imageId)}/accept`, body),

  duplicates: (q: ListDuplicatesQuery = {}) => get<ListDuplicatesResponse>('/duplicates', q),
  resolveDuplicate: (id: ID, keepIds: ID[]) =>
    post<MutationResult>(`/duplicates/${encodeURIComponent(id)}/resolve`, { keepIds }),
  ignoreDuplicate: (id: ID) => post<MutationResult>(`/duplicates/${encodeURIComponent(id)}/ignore`),

  exclusions: () => get<ListExclusionsResponse>('/exclusions'),
  createExclusion: (body: CreateExclusionBody) => post<MutationResult>('/exclusions', body),
  deleteExclusion: (id: ID) => del<MutationResult>(`/exclusions/${encodeURIComponent(id)}`),

  search: (q: string, limit = 20) => get<SearchResponse>('/search', { q, limit }),

  settings: () => get<GetSettingsResponse>('/settings'),
  /** 可选的识别模型（设置页下拉框） */
  taggerModels: () => get<ListTaggerModelsResponse>('/tagger/models'),
  updateSettings: (body: UpdateSettingsBody) => put<Settings>('/settings', body),
  addLibraryRoot: (body: AddLibraryRootBody) => post<MutationResult>('/library-roots', body),
  updateLibraryRoot: (id: ID, enabled: boolean) =>
    patch<MutationResult>(`/library-roots/${encodeURIComponent(id)}`, { enabled }),
  removeLibraryRoot: (id: ID) => del<MutationResult>(`/library-roots/${encodeURIComponent(id)}`),

  jobs: () => get<ListJobsResponse>('/jobs'),
  startJob: (kind: JobKind) => post<Job>('/jobs', { kind }),
  cancelJob: (id: ID) => del<{ ok: true }>(`/jobs/${encodeURIComponent(id)}`),

  undo: (token: string) => post<MutationResult>(`/undo/${encodeURIComponent(token)}`),

  health: () => get<HealthResponse>('/health'),
  /** 由后端弹出系统「选择文件夹」对话框；用户取消时 path 为 null */
  pickFolder: () => post<PickFolderResponse>('/system/pick-folder'),
};
