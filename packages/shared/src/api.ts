/**
 * HTTP API 契约。
 *
 * 所有接口都在 `/api` 前缀下，JSON 进 JSON 出。
 * 前端只通过 `apps/web/src/lib/api.ts` 调用；后端路由在 `apps/server/src/routes/`。
 * 改接口时三处一起改：这里 → 后端路由 → 前端 api.ts。
 */
import type {
  Character,
  CharacterSource,
  CollectionKind,
  CollectionPage,
  CollectionSummary,
  DuplicateGroup,
  Exclusion,
  ExclusionKind,
  FocusPoint,
  ID,
  ContentKind,
  ContentKindSummary,
  ImageDetail,
  ImageItem,
  ImageStatus,
  Job,
  JobKind,
  LibraryStats,
  Rating,
  Settings,
  UnrecognizedItem,
  Work,
} from './domain.ts';

// ---------------------------------------------------------------- 通用

export interface Page<T> {
  items: T[];
  /** 下一页游标；null 表示没有更多 */
  nextCursor: string | null;
  /** 满足筛选条件的总数 */
  total: number;
}

export interface PageQuery {
  cursor?: string;
  /** 默认 60，最大 200 */
  limit?: number;
}

/**
 * 所有会改数据的接口都返回它。
 * 带 undoToken 的操作可以通过 `POST /api/undo/:token` 撤销（顶栏的撤销按钮 / Ctrl+Z）。
 */
export interface MutationResult {
  ok: true;
  /** 给 toast 用的一句话，例如「已将 12 张图归到 圣园未花」 */
  message: string;
  undoToken: string | null;
}

export interface ApiError {
  ok: false;
  error: string;
  /** 机器可读的错误码 */
  code: 'not_found' | 'bad_request' | 'conflict' | 'not_implemented' | 'internal';
}

// ---------------------------------------------------------------- 统计

/** GET /api/stats */
export type GetStatsResponse = LibraryStats;

// ---------------------------------------------------------------- 作品

export type WorkSort = 'imageCount' | 'recent' | 'name';

/** GET /api/works?sort= */
export interface ListWorksQuery {
  sort?: WorkSort;
}
export type ListWorksResponse = Work[];

/** GET /api/works/:id */
export type GetWorkResponse = Work;

// ---------------------------------------------------------------- 角色

export type CharacterSort = 'imageCount' | 'recent' | 'name' | 'newCount';

/** GET /api/characters */
export interface ListCharactersQuery extends PageQuery {
  /** 作品筛选；特殊值 `recent` = 最近 30 天有新增的 */
  workId?: ID | 'recent';
  /** 按名字 / 别名 / Danbooru 标签 / 作品名模糊搜索 */
  q?: string;
  sort?: CharacterSort;
  source?: CharacterSource;
  /** 也列出「只出现在非插画里」的角色（默认隐藏） */
  includeOther?: boolean;
}
export type ListCharactersResponse = Page<Character> & {
  /** 当前筛选下被隐藏的「插画 0 张、但有其他类型」的角色数 */
  otherOnlyCount: number;
};

/** GET /api/characters/top?limit=9 —— 「你最常看的」，按收藏张数排序 */
export interface TopCharactersQuery {
  limit?: number;
  workId?: ID | 'recent';
}
export type TopCharactersResponse = Character[];

/** GET /api/characters/:id */
export interface GetCharacterResponse {
  character: Character;
  works: Work[];
  /** 经常一起出现的角色（同一张图里） */
  related: { character: Character; sharedCount: number }[];
}

/** POST /api/characters —— 新建自建角色 */
export interface CreateCharacterBody {
  name: string;
  workIds: ID[];
  aliases?: string[];
  danbooruTag?: string | null;
}

/** PATCH /api/characters/:id */
export interface UpdateCharacterBody {
  name?: string;
  aliases?: string[];
  danbooruTag?: string | null;
  workIds?: ID[];
  coverImageId?: ID | null;
  coverFocus?: FocusPoint | null;
  pinned?: boolean;
}

/** POST /api/characters/:id/seen —— 清掉「+N」角标，无 undo */

/** POST /api/characters/:id/merge —— 把 :id 合并进 targetId */
export interface MergeCharacterBody {
  targetId: ID;
}

/** GET /api/characters/:id/cover-candidates?limit=12 —— 「换封面」面板（CB-7） */
export interface CoverCandidatesQuery {
  /** 默认 12，最多 48 */
  limit?: number;
}

/** 候选封面：和自动封面同一套排序（漫画页最后 → 分级档位 → 画面质量分）；封面不是手动设的时，第一张就是当前自动封面 */
export type CoverCandidate = ImageItem & { coverScore: number };

export interface CoverCandidatesResponse {
  items: CoverCandidate[];
}

// ---------------------------------------------------------------- 图片

/** page = 合集里的页序，只在 collectionId 是具体 id 时有效，否则当 addedAt */
export type ImageSort = 'addedAt' | 'modifiedAt' | 'fileName' | 'bytes' | 'random' | 'page';

/** GET /api/images */
export interface ListImagesQuery extends PageQuery {
  characterId?: ID;
  workId?: ID;
  status?: ImageStatus;
  rating?: Rating[];
  /** 文件名 / 标签搜索 */
  q?: string;
  orientation?: 'portrait' | 'landscape' | 'square';
  /** 画面（多归属，只看识别过的图的标签） */
  theme?: BrowseTheme;
  /** 自定义画面：有其中任一一般标签（分数达到 TAG_FILTER_MIN_SCORE）的图 */
  tags?: string[];
  favorite?: boolean;
  /** true = 用户归为原创的图；false = 没归为原创的 */
  original?: boolean;
  /** 内容类型；不传或 'all' = 全部类型 */
  kind?: ContentKind[] | 'all';
  /** true = 分级可信（识别过，或手动设过分级） */
  rated?: boolean;
  /** 随机排序的种子（0–1073741823），只在 sort='random' 时生效：同一个种子结果相同 */
  seed?: number;
  /** 合集：具体 id = 这一本的页；'none' = 不在任何合集里的图（T38c） */
  collectionId?: ID | 'none';
  sort?: ImageSort;
  order?: 'asc' | 'desc';
}
export type ListImagesResponse = Page<ImageItem>;

/** GET /api/images/:id */
export type GetImageResponse = ImageDetail;

/** PATCH /api/images/:id */
export interface UpdateImageBody {
  characterIds?: ID[];
  rating?: Rating;
  favorite?: boolean;
  /** 'auto' = 清掉手动设置，按规则重判 */
  kind?: ContentKind | 'auto';
}

export type BulkImageAction =
  | { type: 'assign'; characterId: ID }
  | { type: 'unassign'; characterId: ID }
  | { type: 'exclude' }
  | { type: 'restore' }
  | { type: 'favorite'; value: boolean }
  | { type: 'rating'; value: Rating }
  /** 改内容类型；'auto' = 恢复自动判断 */
  | { type: 'kind'; value: ContentKind | 'auto' }
  /** 移到系统回收站（不是永久删除） */
  | { type: 'trash' }
  /** 放下：不找角色了，不再出现在未识别（T34a）；false = 放回 */
  | { type: 'shelve'; value: boolean }
  /** 归为原创（true）/ 移出原创（false）：挂到「原创」作品、离开未识别 */
  | { type: 'original'; value: boolean };

/** POST /api/images/bulk */
export interface BulkImagesBody {
  ids: ID[];
  action: BulkImageAction;
}

/**
 * 图片文件本身不走 JSON：
 * - GET /api/images/:id/thumb?w=480  缩略图（webp，按宽度取最近的档位 240/480/960）
 * - GET /api/images/:id/file         原图
 * - POST /api/images/:id/reveal      在资源管理器中显示
 */
export const THUMB_WIDTHS = [240, 480, 960] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

// ---------------------------------------------------------------- 合集（T38）

/**
 * GET    /api/collections            列表（按 title 排，无题排最后；页数为 0 的不列）
 * GET    /api/collections/:id        一本：目次、出场角色、作品、同系列
 * POST   /api/collections            把一个文件夹做成合集 → MutationResult & { collection }
 * PATCH  /api/collections/:id        改名、改类型、换封面、页序、系列、已整理、手动关联
 * DELETE /api/collections/:id        不成册（留一行 dismissed，自动判定不会再建）
 * POST   /api/collections/bulk       批量：标为已整理、关联角色 / 作品、改类型
 */
export interface ListCollectionsQuery {
  kind?: CollectionKind;
  characterId?: ID;
  workId?: ID;
  seriesKey?: string;
  pending?: boolean;
  q?: string;
}
export type ListCollectionsResponse = CollectionSummary[];

export interface GetCollectionResponse {
  collection: CollectionSummary;
  pages: CollectionPage[];
  cast: { character: Character; pageCount: number; manual: boolean }[];
  works: { work: Work; pageCount: number; manual: boolean }[];
  folderPath: string;
  pageOrder: 'name' | 'mtime';
  evidence: string | null;
  reviewed: boolean;
  /** 同系列各话，按 volumeNo 升序（含自己）；没有系列时为 [] */
  series: CollectionSummary[];
}

export interface CreateCollectionBody {
  /** 这张图所在的文件夹做成合集 */
  fromImageId: ID;
  kind: CollectionKind;
}

export interface UpdateCollectionBody {
  /** null = 恢复自动名 */
  title?: string | null;
  kind?: CollectionKind | 'auto';
  coverImageId?: ID | null;
  pageOrder?: 'name' | 'mtime';
  /** null = 恢复自动 */
  seriesKey?: string | null;
  volumeNo?: number | null;
  reviewed?: boolean;
  manualCharacterIds?: ID[];
  manualWorkIds?: ID[];
}

export type BulkCollectionAction =
  | { type: 'review' }
  | { type: 'addCharacter'; characterId: ID }
  | { type: 'addWork'; workId: ID }
  | { type: 'kind'; value: CollectionKind };
export interface BulkCollectionsBody {
  ids: ID[];
  action: BulkCollectionAction;
}

// ---------------------------------------------------------------- 未识别

/** 未识别的两个大类：插画和漫画（要找角色）/ 照片、文字等（别册里没有角色的） */
export const UNRECOGNIZED_AREAS = ['art', 'annex'] as const;
export type UnrecognizedArea = (typeof UNRECOGNIZED_AREAS)[number];
/** 插画和漫画的分段：有建议 / 没认出 / 待识别 / 放下的 */
export const UNRECOGNIZED_BUCKETS = ['suggested', 'unsure', 'untagged', 'shelved'] as const;
export type UnrecognizedBucket = (typeof UNRECOGNIZED_BUCKETS)[number];
/** 「照片 · 文字等」大类里的五类 */
export const UNRECOGNIZED_ANNEX_KINDS = ['screenshot', 'text', 'photo', 'meme', 'animated'] as const;
export type UnrecognizedAnnexKind = (typeof UNRECOGNIZED_ANNEX_KINDS)[number];

/** GET /api/unrecognized —— 参数和大类不匹配时一律忽略，不报错 */
export interface ListUnrecognizedQuery extends PageQuery {
  /** 默认 'art' */
  area?: UnrecognizedArea;
  /** 只对 art 有效；不传 = 有建议 + 没认出 + 待识别，不含放下的。total 是所请求分段的数量 */
  bucket?: UnrecognizedBucket;
  /** 只在 art + bucket='unsure' 时有效 */
  theme?: UnrecognizedTheme;
  /** 只对 annex 有效；不传 = 五类合起来 */
  kind?: UnrecognizedAnnexKind;
}

/** GET /api/unrecognized/summary —— art.total = suggested + unsure + untagged（不含放下的）；themes 只统计 unsure */
export interface UnrecognizedSummary {
  art: {
    total: number;
    suggested: number;
    unsure: number;
    untagged: number;
    shelved: number;
    themes: Record<UnrecognizedTheme, number>;
    /** 识别过、没认出角色、没放下的插画：「用主模型重新识别」会把它们再认一遍 */
    retaggable: number;
  };
  annex: { total: number; kinds: Record<UnrecognizedAnnexKind, number> };
}
/** POST /api/unrecognized/retag：标记了多少张、启动（或已在跑）的识别任务 */
export interface RetagResult {
  marked: number;
  job: Job | null;
}
export type ListUnrecognizedResponse = Page<UnrecognizedItem> & {
  /** 未识别图里 tagger 给出过建议的张数（整个队列，不只是这一页） */
  suggestedCount: number;
  /** 识别过、但没有任何建议的张数 */
  unsureCount: number;
  /** 还没跑过识别（也没有建议）的张数 */
  untaggedCount: number;
  /** 别册（既不是插画也不是漫画）里没有角色的张数 */
  annexCount: number;
};

/**
 * 「没认出」里的画面主题（T27 补充），顺序就是目次顺序。一图一组，见 services/classify/theme.ts。
 */
export const UNRECOGNIZED_THEMES = ['legs', 'chest', 'nsfw', 'swim', 'kemono', 'costume', 'multi', 'other', 'comic', 'odd'] as const;
export type UnrecognizedTheme = (typeof UNRECOGNIZED_THEMES)[number];

/**
 * 浏览用的画面筛选（图库、角色页、作品页）：和未识别的主题同一套标签规则，但可以多归属——
 * 穿丝袜的泳装图在「腿·足」和「泳装」里都能看到。敏感交给分级筛选，不在这里。
 */
export const BROWSE_THEMES = ['legs', 'chest', 'swim', 'kemono', 'costume', 'multi'] as const;
export type BrowseTheme = (typeof BROWSE_THEMES)[number];

/** GET /api/content-kinds —— 按 CONTENT_KINDS 顺序，7 项，count 可以为 0 */
export type ListContentKindsResponse = ContentKindSummary[];

/**
 * POST /api/unrecognized/:imageId/accept —— 采纳一个建议（可能会新建角色）
 */
export interface AcceptSuggestionBody {
  danbooruTag: string;
}

// ---------------------------------------------------------------- 重复

/** GET /api/duplicates?resolved=false */
export interface ListDuplicatesQuery {
  resolved?: boolean;
}
export type ListDuplicatesResponse = DuplicateGroup[];

/** POST /api/duplicates/:id/resolve —— 保留 keepIds，其余移入回收站 */
export interface ResolveDuplicateBody {
  keepIds: ID[];
}

/** POST /api/duplicates/:id/ignore —— 标记为「不是重复」 */

// ---------------------------------------------------------------- 排除

/** GET /api/exclusions */
export type ListExclusionsResponse = Exclusion[];

/** POST /api/exclusions */
export interface CreateExclusionBody {
  kind: ExclusionKind;
  target: string;
}

/** DELETE /api/exclusions/:id —— 恢复 */

// ---------------------------------------------------------------- 搜索（⌘K）

export type SearchHit =
  | { type: 'character'; character: Character; workName: string | null }
  | { type: 'work'; work: Work }
  | { type: 'tag'; tag: string; imageCount: number };

/** GET /api/search?q=&limit=20 */
export interface SearchQuery {
  q: string;
  limit?: number;
}
export type SearchResponse = SearchHit[];

// ---------------------------------------------------------------- 标签

/** GET /api/tags?q=&limit=20 —— 一般标签联想（自定义画面用）；q 为空 = 最常见的 */
export interface TagSuggestionsQuery {
  q?: string;
  limit?: number;
}
export interface TagSuggestion {
  /** 原始标签名，如 `white_hair` */
  tag: string;
  /** 显示名：有中文用中文，否则把下划线换成空格 */
  name: string;
  /** 有这个标签的图数（分数达到 TAG_FILTER_MIN_SCORE 的） */
  count: number;
}
export type TagSuggestionsResponse = TagSuggestion[];

/** 自定义画面按标签筛图时的最低分数（和内置画面里最宽的一组一致） */
export const TAG_FILTER_MIN_SCORE = 0.5;
/** 自定义画面的数量 / 名字 / 标签上限 */
export const CUSTOM_THEME_LIMITS = { themes: 30, name: 12, tags: 20 } as const;

// ---------------------------------------------------------------- 设置

/** GET /api/settings */
export type GetSettingsResponse = Settings;

/** PUT /api/settings —— 深合并；libraryRoots 用下面单独的接口改 */
export type UpdateSettingsBody = DeepPartial<Omit<Settings, 'libraryRoots'>> & {
  /** 只在设置时传，读取时永远不回显 */
  danbooruApiKey?: string;
};

/** GET /api/tagger/models —— 可选的识别模型，给设置页的下拉框用 */
export interface TaggerModelInfo {
  /** = Settings.tagger.model 的取值 */
  repo: string;
  label: string;
  /** 要下载的文件总大小 */
  sizeBytes: number;
  /** 能认的角色标签数 */
  characterCount: number;
  /** 训练数据截止（YYYY-MM），之后出的角色认不出 */
  dataUntil: string;
  /** 选 GPU 时走哪个后端 */
  gpu: 'dml' | 'webgpu';
  /** 一句话：什么情况下选它 */
  note: string;
  isDefault: boolean;
  /** 模型文件已经在本机、校验过 */
  downloaded: boolean;
}
export type ListTaggerModelsResponse = TaggerModelInfo[];

/** POST /api/library-roots { path } / DELETE /api/library-roots/:id / PATCH { enabled } */
export interface AddLibraryRootBody {
  path: string;
}

// ---------------------------------------------------------------- 后台任务

/** GET /api/jobs */
export type ListJobsResponse = Job[];

/** POST /api/jobs */
export interface StartJobBody {
  kind: JobKind;
}

/**
 * GET /api/events —— Server-Sent Events
 * 事件类型见 ServerEvent；前端收到后让对应的 query 失效。
 */
export type ServerEvent =
  | { type: 'job'; job: Job }
  | JobItemEvent
  | { type: 'library-changed'; reason: 'scan' | 'tag' | 'mutation' }
  | { type: 'stats'; stats: LibraryStats };

/**
 * 识别胶卷（SEL-19）：tag 任务刚识别完的一张图。每批最多推一条、每秒最多 4 条；
 * 只用来给首页横幅和侧栏任务环做「在干活」的反馈，不触发任何 query 失效。
 */
export interface JobItemEvent {
  type: 'job-item';
  jobId: ID;
  imageId: ID;
  dominantColor: string | null;
  rating: Rating;
  kind: ContentKind;
  /** 这张图归到的角色（最多 2 个），没认出来是空数组 */
  characterNames: string[];
  /** 最高的角色分数；没认出来是 null */
  score: number | null;
}

// ---------------------------------------------------------------- 系统

/**
 * 防休眠的当前状态（设置 → 识别里显示）：off 设置里关着；idle 开着但没有任务在跑；active 正在阻止休眠
 * （screenOn：现代待机的电脑上屏幕也保持亮着）；failed 没生效（detail 是原因）；unsupported 这个系统不支持。
 */
export interface KeepAwakeStatus {
  state: 'off' | 'idle' | 'active' | 'failed' | 'unsupported';
  screenOn: boolean;
  detail: string | null;
}

/** GET /api/health */
export interface HealthResponse {
  ok: true;
  dataSource: 'mock' | 'sqlite';
  /** 根 package.json 的 version */
  version: string;
  /** 数据目录的绝对路径（只监听本机，返回路径没有问题） */
  dataDir: string;
  /** 防休眠状态；演示数据下没有 */
  keepAwake?: KeepAwakeStatus;
}

/** POST /api/system/pick-folder —— 由后端弹出系统「选择文件夹」对话框；取消时 path 为 null */
export interface PickFolderResponse {
  path: string | null;
}

/** POST /api/system/network-check —— 连不上 Danbooru 时排查用 */
export interface NetworkCheckResponse {
  proxy: {
    /** 实际在用的代理；null 是直连 */
    url: string | null;
    /** env：.env 或环境变量；system：Windows 系统代理；pac：系统的自动配置脚本 */
    source: 'env' | 'system' | 'pac' | null;
    /** 检测到了但没用上的原因，比如系统代理开着、端口却没在监听 */
    note: string | null;
  };
  targets: { name: string; url: string; ok: boolean; ms: number | null; message: string }[];
  /** 一句话结论和建议 */
  summary: string;
}

// ---------------------------------------------------------------- 撤销

/** POST /api/undo/:token */
export type UndoResponse = MutationResult;

// ---------------------------------------------------------------- 工具类型

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};
