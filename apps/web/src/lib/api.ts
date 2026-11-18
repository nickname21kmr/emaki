/**
 * 前端唯一的 HTTP 出口。页面组件不要直接 fetch，走 lib/queries.ts 里的 hook。
 * 接口定义见 packages/shared/src/api.ts。
 */
import type {
  AccessStatus,
  AccessTicket,
  DeviceInfo,
  Me,
  Scope,
  AcceptSuggestionBody,
  DomainChange,
  UndoKind,
  UndoStatusResponse,
  AddLibraryRootBody,
  ApiError,
  BulkCollectionsBody,
  BulkImagesBody,
  CollectionCountsQuery,
  CollectionCountsResponse,
  CollectionSummary,
  CreateCollectionBody,
  GetCollectionResponse,
  ListCollectionsQuery,
  ListArtistsResponse,
  ListCollectionsResponse,
  UpdateCollectionBody,
  Character,
  ContentKind,
  CoverCandidatesQuery,
  CoverCandidatesResponse,
  CreateCharacterBody,
  CustomCharacterMatch,
  CreateExclusionBody,
  GetCharacterResponse,
  GetImageResponse,
  GetSettingsResponse,
  GetStatsResponse,
  LibrarySummary,
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
import { noteResponse } from './deviceAuth';
import { uuid } from './random';

/**
 * 写命令的结果附带的说明（命令层放在响应头里，docs/core-architecture.md 第 4.1、9 节）：
 * command 命令名；undo 撤销栈里怎么记（token 可撤销、barrier 不可撤销的命令＝撤销屏障、none 不占位置，由注册表决定，前端不再自己判断）；
 * eventId 这次推出去的最后一条 changed 事件（前端等它到了就不用自己刷新，lib/events.ts 的 settleRefresh）；changes 变了哪些事实
 */
export interface CommandMeta {
  command: string;
  undo: UndoKind;
  eventId: number | null;
  changes: DomainChange[];
}

const META = Symbol('emaki.command');

/** 写命令的说明（不是命令的接口、旧后端没有） */
export const metaOf = (value: unknown): CommandMeta | undefined =>
  value && typeof value === 'object' ? ((value as Record<symbol, CommandMeta | undefined>)[META] ?? undefined) : undefined;

/** 把说明挂到结果上（不可枚举：不进 JSON、不影响比较） */
export function attachMeta<T extends object>(target: T, meta: CommandMeta): T {
  Object.defineProperty(target, META, { value: meta, enumerable: false, configurable: true });
  return target;
}

/** 把 from 上的说明搬到 target（包一层 MutationResult 时用） */
export function withMeta<T extends object>(target: T, from: unknown): T {
  const meta = metaOf(from);
  return meta ? attachMeta(target, meta) : target;
}

function readMeta(res: Response): CommandMeta | undefined {
  const command = res.headers.get('x-emaki-command');
  if (!command) return undefined;
  const event = res.headers.get('x-emaki-event');
  const changes = res.headers.get('x-emaki-changes');
  return {
    command,
    undo: (res.headers.get('x-emaki-undo') as UndoKind | null) ?? 'none',
    eventId: event ? Number(event) : null,
    changes: changes ? (changes.split(',') as DomainChange[]) : [],
  };
}

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
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // 写请求带 operationId（Idempotency-Key）：同一个键重试，服务端返回第一次的结果，不会做两遍
  if (method !== 'GET') headers['Idempotency-Key'] = uuid();
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
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
    // 局域网入口上没有凭证 / 被电脑移除了：整页换成「连接到电脑」；403 forbidden 时重新取 /api/me（lib/deviceAuth.ts）
    noteResponse(res.status, err?.code, path);
    throw new ApiRequestError(res.status, err?.code ?? 'internal', err?.error ?? `请求失败（${res.status}）`);
  }
  const meta = readMeta(res);
  if (meta && data && typeof data === 'object') attachMeta(data, meta);
  return data as T;
}

const get = <T>(path: string, params?: object) => request<T>('GET', `${path}${toQueryString(params)}`);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
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
  summary: () => get<LibrarySummary>('/summary'),
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
  collectionCounts: (q: CollectionCountsQuery = {}) => get<CollectionCountsResponse>('/collections/counts', q),
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

  search: (q: string, limit = 20, forAssignment = false) => get<SearchResponse>('/search', { q, limit, ...(forAssignment ? { forAssignment } : {}) }),
  /** 一般标签联想（自定义画面）；q 为空 = 最常见的 */
  tags: (q: string, limit = 20) => get<TagSuggestionsResponse>('/tags', { q, limit }),

  settings: () => get<GetSettingsResponse>('/settings'),
  /** 可选的识别模型（设置页下拉框） */
  taggerModels: () => get<ListTaggerModelsResponse>('/tagger/models'),
  /** 当前可补采纳的模型建议 */
  promotableSuggestions: (kind?: ContentKind) => get<PromotableSuggestions>('/tagger/promotable', { kind }),
  /** 把达标的建议归到角色（可撤销） */
  promoteSuggestions: (kind?: ContentKind) => post<MutationResult>('/tagger/promote', { kind }),
  /** 设置用 PATCH（PUT 是兼容的旧写法） */
  updateSettings: (body: UpdateSettingsBody) => patch<Settings>('/settings', body),
  addLibraryRoot: (body: AddLibraryRootBody) => post<MutationResult>('/library-roots', body),
  updateArtistLinks: (body: UpdateArtistLinksBody) => post<MutationResult>('/artists/links', body),
  updateLibraryRoot: (id: ID, body: UpdateLibraryRootBody) => patch<MutationResult>(`/library-roots/${encodeURIComponent(id)}`, body),
  removeLibraryRoot: (id: ID) => del<MutationResult>(`/library-roots/${encodeURIComponent(id)}`),

  jobs: () => get<ListJobsResponse>('/jobs'),
  startJob: (kind: JobKind, options?: Pick<StartJobBody, 'refreshPixiv'>) => post<Job>('/jobs', { kind, ...options }),
  cancelJob: (id: ID) => del<{ ok: true }>(`/jobs/${encodeURIComponent(id)}`),

  undo: (token: string) => post<MutationResult>(`/undo/${encodeURIComponent(token)}`),
  /** 只读的查询用 GET；令牌多了地址太长时用 POST */
  undoStatus: (tokens: string[]) =>
    tokens.length <= 50 ? get<UndoStatusResponse>('/undo/status', { tokens }) : post<UndoStatusResponse>('/undo/status', { tokens }),

  health: () => get<HealthResponse>('/health'),
  /** 谁在调用：本机入口 local、全部范围；局域网入口是这台设备和它真正生效的范围（lib/capabilities.ts） */
  me: () => get<Me>('/me'),
  /** 由后端弹出系统「选择文件夹」对话框；用户取消时 path 为 null */
  pickFolder: () => post<PickFolderResponse>('/system/pick-folder'),
  /** 移到图库里的某个文件夹（磁盘上真的移动），可撤销 */
  moveImages: (body: MoveImagesBody) => post<MutationResult>('/images/move', body),
  /** 移动前先数：服务端会移哪些图（按角色移动时拿这里的 ids 再提交） */
  previewMove: (body: MoveImagesBody) =>
    !body.ids || body.ids.length <= 200 ? get<MovePreview>('/images/move/preview', body) : post<MovePreview>('/images/move/preview', body),
  /** 切换 Pixiv 投稿号识别方式：先数影响，再切换（可撤销） */
  previewSourceMode: (mode: 'strict' | 'broad') => get<SourceModePreview>(`/settings/source-mode?mode=${mode}`),
  setSourceMode: (mode: 'strict' | 'broad') => post<MutationResult>('/settings/source-mode', { mode }),
  /** 最近的改动（自动关联、Pixiv 补充 / 移动到文件夹），重启后也能撤回 */
  changes: (group: ChangeGroup) => get<ChangeEntry[]>(`/changes?group=${group}`),
  revertChange: (id: ID) => post<MutationResult>(`/changes/${encodeURIComponent(id)}/revert`),
  /** 连一下 Danbooru、Hugging Face 和国内镜像，排查同步失败 */
  checkNetwork: () => get<NetworkCheckResponse>('/system/network-check'),

  // 手机访问（docs/mobile.md 第 2 节）：scope 是 devices，只有本机入口能用（局域网入口上是 403）；都不可撤销、不占撤销栈
  accessStatus: () => get<AccessStatus>('/access'),
  /** 打开 / 关闭局域网入口、改端口、改电脑名称（name 为 null 恢复成计算机名），立即生效 */
  configureAccess: (body: { enabled?: boolean; port?: number; name?: string | null }) =>
    patch<{ ok: true; message: string; status: AccessStatus }>('/access', body),
  /** 批准连接请求：scopes 不给是默认权限 */
  approveDevice: (id: string, body: { scopes?: Scope[]; name?: string } = {}) =>
    post<{ ok: true; message: string; device: DeviceInfo }>(`/access/requests/${encodeURIComponent(id)}/approve`, body),
  rejectDevice: (id: string) => post<{ ok: true; message: string }>(`/access/requests/${encodeURIComponent(id)}/reject`),
  updateDevice: (id: string, body: { name?: string; scopes?: Scope[] }) =>
    patch<{ ok: true; message: string; device: DeviceInfo }>(`/devices/${encodeURIComponent(id)}`, body),
  /** 移除设备：它立即断开，要用的话得重新请求 */
  revokeDevice: (id: string) => del<{ ok: true; message: string }>(`/devices/${encodeURIComponent(id)}`),
  /** 扫码添加用的一次性口令（2 分钟有效，用一次就失效）；局域网入口没开时 409 */
  createAccessTicket: () => post<AccessTicket>('/access/tickets'),
};
