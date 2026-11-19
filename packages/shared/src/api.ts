/**
 * HTTP API 契约。
 *
 * 所有接口都在 `/api` 前缀下，JSON 进 JSON 出。
 * 前端只通过 `apps/web/src/lib/api.ts` 调用；后端路由在 `apps/server/src/routes/`。
 * 请求参数（*Query / *Body）的类型从 schemas.ts 的 zod schema 推出来，后端用同一个 schema 校验；响应类型写在这里。
 * 改请求参数时改 schemas.ts，前端 api.ts 和后端路由的类型会一起跟着变。
 */
import type { z } from 'zod';
import type * as S from './schemas.ts';
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
  LibraryRootMode,
  LibraryStats,
  Rating,
  Settings,
  UnrecognizedItem,
  Work,
} from './domain.ts';

// ---------------------------------------------------------------- 通用

/** 收拢组图选「自动」时的门槛：当前筛选结果超过这么多张才收拢，少的时候逐张展开 */
export const AUTO_COLLAPSE_MIN = 300;

export interface Page<T> {
  /** 收拢组图时的格数；total 仍是图片张数 */
  displayTotal?: number;
  /** 这一列表收拢了组图（collapseCollections='auto' 时由结果张数决定，翻页沿用第一页的决定） */
  collapsed?: boolean;
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
  /** 做了但撤销不了（文件已移到系统回收站）：前端在撤销栈里占一格，Ctrl+Z 不会越过它去撤销更早的操作 */
  irreversible?: true;
  /** 这次移到回收站把更早的几次挤出了可撤销的窗口（文件已放进系统回收站）：这些 token 撤销不了了 */
  expiredUndoTokens?: string[];
}

/** POST /api/images/import: copy downloaded local files into an existing library root. */
export type ImportImagesBody = z.infer<typeof S.importImagesBody>;
export interface ImportImagesResult extends MutationResult {
  items: ({ path: string; status: 'imported' | 'existing'; imageId: ID; absPath: string }
    | { path: string; status: 'failed'; error: string; code?: 'needs_confirm'; existingImageId?: ID })[];
}

/** POST /api/images/:id/replace: upgrade an existing image, retaining its identity and metadata. */
export type ReplaceImageBody = z.infer<typeof S.replaceImageBody>;
export interface ReplaceImageResult extends MutationResult { imageId: ID; absPath: string }

export interface ApiError {
  ok: false;
  error: string;
  /** 机器可读的错误码 */
  /** needs_confirm：要用户确认，error 是要问的问题（例如添加父文件夹时合并已有文件夹） */
  code: 'not_found' | 'bad_request' | 'conflict' | 'needs_confirm' | 'not_implemented' | 'internal';
}

// ---------------------------------------------------------------- 统计

/** GET /api/stats */
export type GetStatsResponse = LibraryStats;

// ---------------------------------------------------------------- 作品

export type WorkSort = NonNullable<ListWorksQuery['sort']>;

/** GET /api/works?sort= */
export type ListWorksQuery = z.infer<typeof S.listWorksQuery>;
export type ListWorksResponse = Work[];

/** GET /api/works/:id */
export type GetWorkResponse = Work;

// ---------------------------------------------------------------- 角色

export type CharacterSort = NonNullable<ListCharactersQuery['sort']>;

/** GET /api/characters */
export type ListCharactersQuery = z.infer<typeof S.listCharactersQuery>;
export type ListCharactersResponse = Page<Character> & {
  /** 当前筛选下被隐藏的「插画 0 张、但有其他类型」的角色数 */
  otherOnlyCount: number;
};

/** GET /api/characters/top?limit=9 —— 「你最常看的」，按收藏张数排序 */
export type TopCharactersQuery = z.infer<typeof S.topCharactersQuery>;
export type TopCharactersResponse = Character[];

/** GET /api/characters/:id */
export interface GetCharacterResponse {
  character: Character;
  works: Work[];
  /** 经常一起出现的角色（同一张图里） */
  related: { character: Character; sharedCount: number }[];
}

/** POST /api/characters —— 新建自建角色 */
export type CreateCharacterBody = z.infer<typeof S.createCharacterBody>;

/** PATCH /api/characters/:id */
export type UpdateCharacterBody = z.infer<typeof S.updateCharacterBody>;

/** POST /api/characters/:id/seen —— 清掉「+N」角标，无 undo */

/** POST /api/characters/:id/merge —— 把 :id 合并进 targetId */
export type MergeCharacterBody = z.infer<typeof S.mergeCharacterBody>;

/** GET /api/characters/:id/cover-candidates?limit=12 —— 「换封面」面板（CB-7） */
export type CoverCandidatesQuery = z.infer<typeof S.coverCandidatesQuery>;

/** 候选封面：和自动封面同一套排序（漫画页最后 → 分级档位 → 画面质量分）；封面不是手动设的时，第一张就是当前自动封面 */
export type CoverCandidate = ImageItem & { coverScore: number };

export interface CoverCandidatesResponse {
  items: CoverCandidate[];
}

// ---------------------------------------------------------------- 图片

/** page = 合集里的页序，只在 collectionId 是具体 id 时有效，否则当 addedAt */
export type ImageSort = NonNullable<ListImagesQuery['sort']>;

/** GET /api/images */
export type ListImagesQuery = z.infer<typeof S.listImagesQuery>;
export type ListImagesResponse = Page<ImageItem>;

/** GET /api/images/:id */
export type GetImageResponse = ImageDetail;

/** PATCH /api/images/:id */
export type UpdateImageBody = z.infer<typeof S.updateImageBody>;

export type BulkImageAction = BulkImagesBody['action'];

/** POST /api/images/bulk */
export type BulkImagesBody = z.infer<typeof S.bulkImagesBody>;

/**
 * POST /api/images/move —— 把图移到图库里的某个文件夹（磁盘上真的移动），识别和整理结果都保留，可撤销。
 * 合集（本子、画集）里的页不移动；重名的自动改成「a (1).jpg」。
 */
export type MoveImagesBody = z.infer<typeof S.moveImagesBody>;

/**
 * POST /api/images/move/preview —— 移动前先数：服务端实际会移哪些图（按角色移动时以这里返回的 ids 为准再提交）。
 */
export interface MovePreview {
  /** 会真的移动的图（不含本来就在目标里的、合集里的） */
  ids: ID[];
  /** 已经在目标文件夹里的张数 */
  alreadyThere: number;
  /** 合集（本子、画集）里不动的张数 */
  inCollection: number;
  /** 会移动的图里同时属于别的角色的张数（按角色移动时是「除这个角色以外」，选中的图是「两个及以上角色」） */
  otherCharacters: number;
}

/**
 * 最近的改动（GET /api/changes?group=auto|move）：后台自动做的改动和「移动到文件夹」，重启后也能撤回。
 * - auto-associate：自建角色自动绑上了 Danbooru 标签
 * - pixiv-sync：一轮 Pixiv 补充加的角色和原创标记
 * - move：一次移动到文件夹
 */
export type ChangeKind = 'auto-associate' | 'pixiv-sync' | 'move';

export interface ChangeEntry {
  id: ID;
  kind: ChangeKind;
  createdAt: string;
  /** 一句话说明做了什么 */
  summary: string;
  revertedAt: string | null;
  /** 撤回时的补充说明（例如哪些文件没能移回） */
  note: string | null;
  /** 现在撤回会动到的张数（确认框里用）；0 表示已经没什么可撤回的 */
  count: number;
  /** 确认框里的一句话：撤回会做什么；不能撤回时说明原因 */
  revertHint: string;
  /** 现在还能撤回（没撤回过、相关数据没被改掉） */
  revertable: boolean;
}

/** GET /api/changes 的 group：auto = 自动关联和 Pixiv 补充，move = 移动到文件夹 */
export type ChangeGroup = 'auto' | 'move';

/** SSE：后台刚做了一次自动改动（前端弹提示、刷新「最近的自动改动」） */
export interface AutoChangeEvent {
  type: 'auto-change';
  change: ChangeEntry;
}

/** GET /api/settings/source-mode?mode= —— 切换 Pixiv 投稿号识别方式前先数会影响多少张 */
export interface SourceModePreview {
  mode: 'strict' | 'broad';
  /** 自动来源会变的张数（手工填的来源不算） */
  changed: number;
  /** 投稿号变了、先去掉 Pixiv 建议的张数 */
  suggestionsDropped: number;
  /** 拿到新投稿号、要重新补 Pixiv 角色的张数；其中 cached 张有缓存，不用联网 */
  requeued: number;
  cached: number;
}

/**
 * 图片文件本身不走 JSON：
 * - GET /api/images/:id/thumb?w=480  缩略图（webp，按宽度取最近的档位 240/480/960）
 * - GET /api/images/:id/file         原图
 * - POST /api/images/:id/reveal      在资源管理器中显示
 */
export const THUMB_WIDTHS = [240, 480, 960] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

// ---------------------------------------------------------------- 画师

/**
 * GET /api/artists —— 识别出来的画师（PixAI 的 style 输出，分数达到门槛才算），按张数从多到少。
 * 认不出画师的图不在这里。
 */
export interface Artist {
  /** Danbooru 标签，如 mishima_kurone */
  tag: string;
  /** 显示名：Danbooru 资料里的日文 / 汉字名（读音最对得上标签的那个）；没同步过就是标签去掉下划线 */
  name: string;
  /** 合并进来的全部标签（同一个人的旧名、社团名被认成了另一个画师） */
  tags: string[];
  /** 其他名字：日文名、中文名、账号名、社团（搜索用） */
  aliases: string[];
  /** 推特账号（不带 @） */
  twitter: string | null;
  /** 只数计入张数的插画 */
  imageCount: number;
  /** 封面：这位画师分数最高的一张 */
  cover: Pick<ImageItem, 'id' | 'dominantColor' | 'rating' | 'width' | 'height'> | null;
  /** 用户手动拆开 / 合并过这个人的标签（可以恢复自动合并） */
  manual: boolean;
}
export type ListArtistsResponse = Artist[];

/**
 * POST /api/artists/links —— 自动合并猜错了时手动改：
 * split = 这些标签各自单独算一个人；merge = 这些标签并到 into 所在的人；auto = 去掉这些标签的手动设置
 */
export type UpdateArtistLinksBody = z.infer<typeof S.updateArtistLinksBody>;

// ---------------------------------------------------------------- 合集（T38）

/**
 * GET    /api/collections            列表（按 title 排，无题排最后；页数为 0 的不列）
 * GET    /api/collections/:id        一本：目次、出场角色、作品、同系列
 * POST   /api/collections            把一个文件夹做成合集 → MutationResult & { collection }
 * PATCH  /api/collections/:id        改名、改类型、换封面、页序、系列、已整理、手动关联
 * DELETE /api/collections/:id        不成册（留一行 dismissed，自动判定不会再建）
 * POST   /api/collections/bulk       批量：标为已整理、关联角色 / 作品、改类型
 */
export type ListCollectionsQuery = z.infer<typeof S.listCollectionsQuery>;
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

export type CreateCollectionBody = z.infer<typeof S.createCollectionBody>;

export type UpdateCollectionBody = z.infer<typeof S.updateCollectionBody>;

export type BulkCollectionAction = BulkCollectionsBody['action'];
export type BulkCollectionsBody = z.infer<typeof S.bulkCollectionsBody>;

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
/** 「插画 · 漫画」大类里再按类型分：插画 / 漫画（content_kind = 'comic' 的单页；按漫画导入的文件夹本来就不在未识别里） */
export const UNRECOGNIZED_ART_KINDS = ['illustration', 'comic'] as const;
export type UnrecognizedArtKind = (typeof UNRECOGNIZED_ART_KINDS)[number];

/** GET /api/unrecognized —— 参数和大类不匹配时一律忽略，不报错 */
export type ListUnrecognizedQuery = z.infer<typeof S.listUnrecognizedQuery>;

/** GET /api/unrecognized/summary 的参数 */
export type UnrecognizedSummaryQuery = z.infer<typeof S.unrecognizedSummaryQuery>;

/** 「插画 · 漫画」里一类图的分段张数（total 不含放下的） */
export interface UnrecognizedArtCounts {
  total: number;
  suggested: number;
  unsure: number;
  untagged: number;
  shelved: number;
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
    /** 识别过、没认出角色、没放下的插画：「用主模型重新识别」会把它们再认一遍（不受 artKind 影响） */
    retaggable: number;
    /** 插画、漫画各自的分段张数（不受 artKind 影响），两项相加就是不筛选时的分段张数 */
    kinds: Record<UnrecognizedArtKind, UnrecognizedArtCounts>;
  };
  annex: { total: number; kinds: Record<UnrecognizedAnnexKind, number> };
}
/** POST /api/unrecognized/retag：标记了多少张、启动（或已在跑）的识别任务 */
export interface RetagResult {
  marked: number;
  job: Job | null;
}
export type ListUnrecognizedResponse = Page<UnrecognizedItem> & {
  // 下面三个分段计数在传了 artKind 时只算那一类
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
 * POST /api/unrecognized/:imageId/accept —— 采纳一个建议（可能会新建角色）；
 * 传 danbooruTags 时一次采纳这张图的多个建议，只有一条撤销
 */
export type AcceptSuggestionBody = z.infer<typeof S.acceptSuggestionBody>;

// ---------------------------------------------------------------- 重复

/** GET /api/duplicates?resolved=false */
export type ListDuplicatesQuery = z.infer<typeof S.listDuplicatesQuery>;
export type ListDuplicatesResponse = DuplicateGroup[];

/** POST /api/duplicates/:id/resolve —— 保留 keepIds，其余移入回收站 */
export type ResolveDuplicateBody = z.infer<typeof S.resolveDuplicateBody>;

/** POST /api/duplicates/:id/ignore —— 标记为「不是重复」 */

// ---------------------------------------------------------------- 排除

/** GET /api/exclusions */
export type ListExclusionsResponse = Exclusion[];

/** POST /api/exclusions */
export type CreateExclusionBody = z.infer<typeof S.createExclusionBody>;

/** DELETE /api/exclusions/:id —— 恢复 */

// ---------------------------------------------------------------- 搜索（⌘K）

export type SearchHit =
  | { type: 'character'; character: Character; workName: string | null }
  | { type: 'work'; work: Work }
  /** name：显示名，有中文用中文，否则把下划线换成空格 */
  | { type: 'tag'; tag: string; imageCount: number; name: string };

/** GET /api/search?q=&limit=20 */
export type SearchQuery = z.infer<typeof S.searchQuery>;
export type SearchResponse = SearchHit[];

// ---------------------------------------------------------------- 标签

/** GET /api/tags?q=&limit=20 —— 一般标签联想（自定义画面用）；q 为空 = 最常见的 */
export type TagSuggestionsQuery = z.infer<typeof S.tagSuggestionsQuery>;
export interface TagSuggestion {
  /** 原始标签名，如 `white_hair` */
  tag: string;
  /** 显示名：有中文用中文，否则把下划线换成空格 */
  name: string;
  /** 有这个标签的图数（分数达到 TAG_FILTER_MIN_SCORE 的） */
  count: number;
}
export type TagSuggestionsResponse = TagSuggestion[];

/** GET /api/search/phrase?q= —— 「两个黑色长发女孩」→ 2girls + black_hair + long_hair（只给库里有的标签） */
export type TagPhraseQuery = z.infer<typeof S.tagPhraseQuery>;
export interface TagPhraseResponse {
  /** 认出来的标签，按出现顺序；count 和标签联想一样是分数达标的张数 */
  tags: TagSuggestion[];
  /** 没认出来的字（归一化之后的，几段之间空格隔开）；全认出来是空串 */
  rest: string;
  /** 同时有这些标签的图数（和图库「必含」同一口径，不限类型）；一个标签都没认出时是 0 */
  total: number;
}

/** 自定义画面按标签筛图时的最低分数（和内置画面里最宽的一组一致） */
export const TAG_FILTER_MIN_SCORE = 0.5;
/** 自定义画面的数量 / 名字 / 标签上限（标签是三组合计） */
export const CUSTOM_THEME_LIMITS = { themes: 30, name: 12, tags: 20 } as const;

/** 移除的图库文件夹保留整理结果的天数：这期间重新添加同一个文件夹能找回 */
export const REMOVED_ROOT_KEEP_DAYS = 30;

/** GET /api/tagger/promotable —— 已有建议里分数已达自动采纳阈值的（调低阈值后才会有） */
export interface PromotableSuggestions {
  /** 涉及的图片张数 */
  images: number;
  /** 建议条数 */
  suggestions: number;
  threshold: number;
}

// ---------------------------------------------------------------- 设置

/** GET /api/settings */
export type GetSettingsResponse = Settings;

/** PUT /api/settings —— 深合并；libraryRoots 用下面单独的接口改 */
export type UpdateSettingsBody = z.infer<typeof S.updateSettingsBody>;

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
export type AddLibraryRootBody = z.infer<typeof S.addLibraryRootBody>;

/** PATCH /api/library-roots/:id */
export type UpdateLibraryRootBody = z.infer<typeof S.updateLibraryRootBody>;

// ---------------------------------------------------------------- 后台任务

/** GET /api/jobs */
export type ListJobsResponse = Job[];

/** POST /api/jobs */
export type StartJobBody = z.infer<typeof S.startJobBody>;

/**
 * GET /api/events —— Server-Sent Events
 * 事件类型见 ServerEvent；前端收到后让对应的 query 失效。
 */
export type ServerEvent =
  | { type: 'job'; job: Job }
  | JobItemEvent
  | { type: 'library-changed'; reason: 'scan' | 'tag' | 'mutation' }
  | { type: 'stats'; stats: LibraryStats }
  | AutoChangeEvent;

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
  dataSource: 'sqlite' | 'demo';
  /** 根 package.json 的 version */
  version: string;
  /** 数据目录的绝对路径（只监听本机，返回路径没有问题） */
  dataDir: string;
  /** 这次启动的随机 id，重启就变：前端据此丢掉旧的撤销记录（撤销栈只在后端内存里） */
  bootId: string;
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

/** live 还能撤销；undone 已经撤销过；expired 不在撤销栈里了（被挤掉、后端重启过，或者不认识） */
export type UndoTokenStatus = 'live' | 'undone' | 'expired';

/** POST /api/undo/status：问一批 token 现在还能不能撤销（助手勘误条用） */
export type UndoStatusBody = z.infer<typeof S.undoStatusBody>;
export interface UndoStatusResponse {
  status: Record<string, UndoTokenStatus>;
}

// ---------------------------------------------------------------- 工具类型

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

/** GET /api/characters/danbooru-matches：等待用户处理的自建角色匹配。 */
export interface CustomCharacterMatch {
  characterId: ID;
  characterName: string;
  danbooruTag: string;
  matchName: string;
  workName: string | null;
  existingCharacterId: ID | null;
  existingCharacterName: string | null;
}
