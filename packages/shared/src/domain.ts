/**
 * 领域模型 —— 前后端共享的唯一事实来源。
 *
 * 约定：
 * - 所有 ID 都是字符串（后端用 SQLite INTEGER 主键时转成字符串再返回）。
 * - 所有时间都是 ISO 8601 字符串（UTC）。
 * - 「张数」一律指未被排除（status !== 'excluded'）的图片数量。
 */

export type ID = string;
export type ISODate = string;

/** Danbooru 的分级，WD14 tagger 也输出这四档。 */
export type Rating = 'general' | 'sensitive' | 'questionable' | 'explicit';

/** 标签类别，与 Danbooru 的 category 对应。 */
export type TagCategory = 'general' | 'character' | 'copyright' | 'artist' | 'meta';

/** 图片在库中的状态。 */
export type ImageStatus =
  /** 有角色，或不是插画 / 漫画（别册里的图不用找角色） */
  | 'recognized'
  /** 还没有关联任何角色（可能 tagger 还没跑，或者识别置信度不够） */
  | 'unrecognized'
  /** 被用户排除，不参与统计和浏览 */
  | 'excluded';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'bmp';

/**
 * 图片内容类型（T27）。插画是默认类型；其余统称「别册」：不计入角色张数、不进未识别队列（漫画除外，见 T27 补充）。
 */
export type ContentKind = 'illustration' | 'comic' | 'screenshot' | 'text' | 'photo' | 'meme' | 'animated';
export const CONTENT_KINDS: readonly ContentKind[] = ['illustration', 'comic', 'screenshot', 'text', 'photo', 'meme', 'animated'];
/** 别册里的类型 = 除插画以外的全部 */
export const ANNEX_KINDS: readonly ContentKind[] = CONTENT_KINDS.filter((k) => k !== 'illustration');
/** 类型是怎么判出来的 */
export type ContentKindSource = 'name' | 'folder' | 'camera' | 'format' | 'size' | 'tags' | 'manual' | 'default';

/** 图片来源站点，从文件名 / EXIF / 侧车文件推断（例如 pixiv 的 `12345678_p0.png`）。 */
export interface ImageSource {
  site: 'pixiv' | 'twitter' | 'danbooru' | 'fanbox' | 'other';
  url?: string;
  artist?: string;
  postId?: string;
}

/** 作品（IP），对应 Danbooru 的 copyright 标签。 */
export interface Work {
  id: ID;
  /** 显示名（中文优先），例如「蔚蓝档案」 */
  name: string;
  /** Danbooru copyright 标签，例如 `blue_archive`；自建作品为 null */
  danbooruTag: string | null;
  /** 别名，用于搜索：日文名、英文名、简称… */
  aliases: string[];
  characterCount: number;
  /** 只数插画（D3） */
  imageCount: number;
  /** 关联到这部作品、但不是插画的张数（漫画、截图等） */
  otherCount: number;
  /** 最近 30 天新增的插画数，用于「最近在收」 */
  recentImageCount: number;
  coverImageId: ID | null;
  /** 封面图的分级，用于开启「模糊敏感图片」时模糊封面；没有封面时为 general */
  coverRating: Rating;
  /** 作品主题色（从封面图提取），用于 chip 的小色点 / 头像底色 */
  color: string;
  /** 扇形叠放用的封面（0–3 张，互不重复）；[0] 就是 coverImageId */
  covers: CoverRef[];
  /** 封面图的主色（给模糊垫底）；没有封面时为 null */
  coverColor: string | null;
}

/** 一张封面：图、分级（决定是否模糊）、主色、焦点 */
export interface CoverRef {
  imageId: ID;
  rating: Rating;
  color: string | null;
  focus: FocusPoint | null;
}

export type CharacterSource = 'danbooru' | 'custom';

/** 焦点坐标（0~1），用于封面裁剪时保持脸在画面内。 */
export interface FocusPoint {
  x: number;
  y: number;
}

export interface Character {
  id: ID;
  /** 显示名（中文优先），例如「圣园未花」 */
  name: string;
  /** Danbooru character 标签，例如 `mika_(blue_archive)`；未匹配时为 null */
  danbooruTag: string | null;
  /** danbooru = 从 Danbooru 同步来的；custom = 用户自建 */
  source: CharacterSource;
  /** 搜索用别名：ミカ、mika、未花… */
  aliases: string[];
  /** 所属作品（一个角色可能跨作品，例如 Fate 系列），第一个是主作品 */
  workIds: ID[];
  /** 只数插画（D3） */
  imageCount: number;
  /** 关联到这个角色、但不是插画的张数（漫画、截图等） */
  otherCount: number;
  /** 自上次查看该角色以来新增的张数，显示为「+N」角标 */
  newCount: number;
  coverImageId: ID | null;
  /** 封面图的分级（同 Work.coverRating） */
  coverRating: Rating;
  coverFocus: FocusPoint | null;
  /** 封面是用户手动设的（自动选图不会换掉它）；false = 自动选图 */
  coverManual: boolean;
  /** 封面图的主色（给模糊垫底）；没有封面时为 null */
  coverColor: string | null;
  /** 最近 30 天入库的张数（「最近在收」的 +N 和排序用；newCount 是「上次查看以来」） */
  recentCount: number;
  /** 该角色最近一张图的入库时间 */
  lastAddedAt: ISODate | null;
  /** 用户标星 */
  pinned: boolean;
}

export interface TagScore {
  tag: string;
  category: TagCategory;
  /** 0~1；人工添加的标签为 1 */
  score: number;
}

export interface ImageItem {
  id: ID;
  /** 相对于所属库根目录的路径 */
  relPath: string;
  fileName: string;
  libraryRootId: ID;
  width: number;
  height: number;
  bytes: number;
  format: ImageFormat;
  /** 入库时间 */
  addedAt: ISODate;
  /** 文件修改时间 */
  modifiedAt: ISODate;
  rating: Rating;
  status: ImageStatus;
  /** 内容类型（T27） */
  kind: ContentKind;
  characterIds: ID[];
  /** 与 characterIds 同序、同长度：网格悬停时显示「这是谁」（T33，BR-5） */
  characterNames: string[];
  workIds: ID[];
  /** 主色（hex），用于图片加载前的占位底色 */
  dominantColor: string;
  source: ImageSource | null;
  /** 收藏 / 喜欢 */
  favorite: boolean;
}

/** 图片详情 = 列表项 + 全部标签。 */
export interface ImageDetail extends ImageItem {
  absPath: string;
  tags: TagScore[];
  /** tagger 给出的、还没被采纳的角色建议 */
  characterSuggestions: CharacterSuggestion[];
  /** 类型是怎么判出来的；还没判过为 null */
  kindSource: ContentKindSource | null;
  /** 给人看的判定依据，例如「文件夹「表情包2」」「识别标签 comic 0.93」；手动设置时为 null */
  kindReason: string | null;
  /** 所在合集（T38c）；pageNo 是可见页里的序号，恒在 1..pageCount 之间（RV-C-8） */
  collection: { id: ID; kind: CollectionKind; title: string | null; pageNo: number; pageCount: number } | null;
}

/** 合集（T38）：本子 = 漫画为主的同人志 / 单行本；画集 = 插画集。一个文件夹最多一本 */
export type CollectionKind = 'doujin' | 'artbook';

export interface CollectionSummary {
  id: ID;
  kind: CollectionKind;
  /** null = 无题（文件夹名是一串哈希） */
  title: string | null;
  /** 文件夹名原文（NFC） */
  folderName: string;
  event: string | null;
  circle: string | null;
  artist: string | null;
  parody: string | null;
  translator: string | null;
  seriesKey: string | null;
  volumeNo: number | null;
  pageCount: number;
  /** 0–3 张：[0] 封面，[1][2] 书中约 35%、65% 处的页 */
  covers: CoverRef[];
  /** 封面页识别过没有（没识别过的封面分级不可信，开模糊时显示布面） */
  coverTagged: boolean;
  origin: 'auto' | 'manual';
  /** 待整理：本子没有出场角色；画集还有没认出的插画页（RV-C-10） */
  pending: boolean;
  /** 画集：没认出角色的插画页数；本子恒为 0 */
  unrecognizedPageCount: number;
  lastAddedAt: ISODate | null;
  /** 只在按 characterId / workId 筛选时有：这个角色 / 作品出现的页数 */
  matchPageCount?: number;
}

export interface CollectionPage {
  imageId: ID;
  /** 可见页里的序号，1..n */
  pageNo: number;
  width: number;
  height: number;
  rating: Rating;
  kind: ContentKind;
  dominantColor: string;
  /** 识别过没有：没识别过的本子页分级不可信，开模糊时按敏感处理（RV-C-12） */
  tagged: boolean;
}

/** GET /api/content-kinds 的一项：别册首页的抽屉 */
export interface ContentKindSummary {
  kind: ContentKind;
  count: number;
  /** 最近 30 天入库的张数 */
  recentCount: number;
  lastAddedAt: ISODate | null;
  /** 这一类最多的顶层文件夹 */
  topFolder: string | null;
  /** ≤ 3 张，最新的 */
  previews: { id: ID; rating: Rating; dominantColor: string; width: number; height: number }[];
}

export interface CharacterSuggestion {
  /** 如果库里已有该角色则给出 id，否则为 null（采纳时会新建角色） */
  characterId: ID | null;
  danbooruTag: string;
  /** 建议的显示名 */
  name: string;
  workName: string | null;
  score: number;
}

/** 「未识别」队列中的一项。 */
export interface UnrecognizedItem {
  image: ImageItem;
  suggestions: CharacterSuggestion[];
  /** tagger 是否已经处理过这张图 */
  tagged: boolean;
}

export type DuplicateKind =
  /** 字节完全相同 */
  | 'exact'
  /** 感知哈希接近（缩放 / 转码 / 轻微裁剪） */
  | 'similar';

export interface DuplicateGroup {
  id: ID;
  kind: DuplicateKind;
  /** 0~1，组内最低相似度 */
  similarity: number;
  images: ImageItem[];
  /** 推荐保留的图片（分辨率最高 / 体积最大 / 最早入库） */
  suggestedKeepId: ID;
  resolved: boolean;
  /**
   * 可能和别的组是同一套图（差分 CG、连拍）：同一文件夹、尺寸相同、代表图两两相近。
   * 同一个值的组在列表里挨着；只用来放在一起展示，不代表可以删。没有就是 null
   */
  setId: ID | null;
}

export type ExclusionKind = 'image' | 'folder' | 'tag' | 'character';

export interface Exclusion {
  id: ID;
  kind: ExclusionKind;
  /** image → 图片 id；folder → 绝对路径；tag → 标签名；character → 角色 id */
  target: string;
  /** 给人看的描述 */
  label: string;
  /** 这条规则排除掉的图片数量 */
  imageCount: number;
  /** 预览图（最多 4 张） */
  previewImageIds: ID[];
  createdAt: ISODate;
}

export interface LibraryRoot {
  id: ID;
  path: string;
  enabled: boolean;
  imageCount: number;
  lastScanAt: ISODate | null;
  /** 第一次扫描这个文件夹的时间（首页「刚导入」状态用） */
  importedAt: ISODate | null;
}

export interface LibraryStats {
  /** 全部类型的计入张数 */
  imageCount: number;
  /** 有插画的角色数 */
  characterCount: number;
  workCount: number;
  unrecognizedCount: number;
  duplicateGroupCount: number;
  excludedCount: number;
  /** 自建角色里已对上 Danbooru 标签的数量（顶栏「N 个自建角色能对上 Danbooru」） */
  customMatchableCount: number;
  totalBytes: number;
  /** 最近 7 天每天新增的张数，从旧到新，长度 7 */
  addedLast7Days: number[];
  lastScanAt: ISODate | null;
  /** 放下的张数：插画和漫画、没有角色、不找了（T34a，RV-T-4）；不在 unrecognizedCount 里 */
  shelvedCount: number;
  /** 未识别里还没跑过识别的张数（unrecognizedCount 的子集） */
  untaggedCount: number;
  /** 7 天内有文件夹首次导入：at = 最近一次首次导入时间，count = 这些文件夹里计入张数的图；否则 null */
  recentImport: { at: ISODate; count: number } | null;
  /** 插画里最晚的入库时间 */
  lastAddedAt: ISODate | null;
  /** 计入张数的图按类型计数（各项之和 = imageCount） */
  kindCounts: Record<ContentKind, number>;
  /** 全部类型里还没跑过识别的计入张数（首页识别进度用） */
  pendingTagCount: number;
  /** 合集本数（页数 > 0 的） */
  collectionCounts: Record<CollectionKind, number>;
  /** 待整理的合集条目数（同一系列算一条） */
  pendingCollectionCount: number;
}

export type ThemePreference = 'system' | 'light' | 'dark';

/** 自定义「画面」筛选：用户拿识别标签自己拼的一组，图有任一标签（分数够）就算 */
export interface CustomTheme {
  id: string;
  /** 1–12 字 */
  name: string;
  /** danbooru 风格的一般标签名，1–20 个 */
  tags: string[];
}
export type TaggerDevice = 'cpu' | 'dml';

export interface Settings {
  libraryRoots: LibraryRoot[];
  tagger: {
    /** 模型仓库名，例如 `SmilingWolf/wd-eva02-large-tagger-v3` */
    model: string;
    device: TaggerDevice;
    generalThreshold: number;
    characterThreshold: number;
    /** 达到该分数自动采纳角色，低于则进入「未识别」等人工确认 */
    autoAcceptThreshold: number;
    batchSize: number;
    /**
     * 分流（2026-09-27）：文件时间早于 legacyBefore 的图用 legacyModel 识别——旧模型数据截至 2024-02，
     * 那之前的文件里不会有更新的角色，旧模型快约 5 倍。null = 不分流，全部用 model。
     */
    legacyModel: string | null;
    /** YYYY-MM-DD；按文件修改时间比较 */
    legacyBefore: string | null;
    /** 相机拍的照片（EXIF 有相机型号）不识别角色 */
    skipCameraPhotos: boolean;
    /** 旧文件里旧模型没认出角色的，也用新模型再认一遍（慢，默认关） */
    retryOld: boolean;
    /** 扫描、识别等后台任务运行时不让电脑休眠（默认开；只挡睡眠，不挡关屏） */
    keepAwake: boolean;
  };
  danbooru: {
    /** 是否允许联网同步标签元数据 */
    enabled: boolean;
    /** 可选：Danbooru 用户名 + API key，用于标识身份（读接口限速与账号无关） */
    username: string;
    hasApiKey: boolean;
    lastSyncAt: ISODate | null;
  };
  dedupe: {
    /** 感知哈希的汉明距离阈值（0~64），越小越严格 */
    hammingThreshold: number;
    /** 上次查重跑完的时间；从没跑过为 null（只读，客户端不能写） */
    lastRunAt: ISODate | null;
  };
  ui: {
    theme: ThemePreference;
    /** 敏感分级（questionable / explicit）默认模糊 */
    blurSensitive: boolean;
    /** 网格密度 */
    density: 'comfortable' | 'compact';
  };
  browse: {
    /** 自定义画面筛选，最多 30 个，顺序即显示顺序 */
    customThemes: CustomTheme[];
  };
}

export type JobKind = 'scan' | 'thumbnail' | 'tag' | 'danbooru-sync' | 'dedupe';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: ID;
  kind: JobKind;
  status: JobStatus;
  /** 已处理数量 */
  progress: number;
  /** 总量（未知时为 null） */
  total: number | null;
  message: string;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}
