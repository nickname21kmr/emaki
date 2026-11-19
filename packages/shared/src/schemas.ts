/**
 * 请求参数的 zod schema：后端路由拿它们校验，api.ts 里的请求类型用 z.infer 从这里推出来，只写一遍。
 *
 * 单独的入口 `@emaki/shared/schemas`，不从 index 导出：前端只用类型（import type），打包时不会带上 zod。
 * 查询串里的参数是字符串，qNumber / qBool / qList 负责转换；推出来的类型是转换之后的（数字、布尔、数组）。
 */
import { z } from 'zod';
import {
  BROWSE_THEMES,
  CUSTOM_THEME_LIMITS,
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_AREAS,
  UNRECOGNIZED_ART_KINDS,
  UNRECOGNIZED_BUCKETS,
  UNRECOGNIZED_THEMES,
} from './api.ts';
import type { CharacterSource, CollectionKind, ContentKind, ExclusionKind, ImageStatus, JobKind, LibraryRootMode, Rating } from './domain.ts';

// ---------------------------------------------------------------- 工具

/** 两个类型完全相同时是 true（用来保证这里的枚举和 domain.ts 一致） */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>() => undefined as unknown as T;

/** 查询串里的数字 */
export const qNumber = z.coerce.number().int();
/** 查询串里的布尔值：true/false/1/0 */
export const qBool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
/** 查询串里逗号分隔的列表：rating=general,sensitive */
export const qList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(item));

export const idParam = z.object({ id: z.string().min(1) });

// ---------------------------------------------------------------- 枚举

export const ratingSchema = z.enum(['general', 'sensitive', 'questionable', 'explicit']);
export const contentKindSchema = z.enum(['illustration', 'comic', 'screenshot', 'text', 'photo', 'meme', 'animated']);
export const imageStatusSchema = z.enum(['recognized', 'unrecognized', 'excluded']);
export const characterSourceSchema = z.enum(['danbooru', 'custom']);
export const collectionKindSchema = z.enum(['doujin', 'artbook', 'group']);
export const exclusionKindSchema = z.enum(['image', 'folder', 'tag', 'character']);
export const rootModeSchema = z.enum(['auto', 'comic']);
export const jobKindSchema = z.enum(['scan', 'thumbnail', 'tag', 'danbooru-sync', 'dedupe', 'artists', 'pixiv-tags']);
same<Same<z.infer<typeof ratingSchema>, Rating>>();
same<Same<z.infer<typeof contentKindSchema>, ContentKind>>();
same<Same<z.infer<typeof imageStatusSchema>, ImageStatus>>();
same<Same<z.infer<typeof characterSourceSchema>, CharacterSource>>();
same<Same<z.infer<typeof collectionKindSchema>, CollectionKind>>();
same<Same<z.infer<typeof exclusionKindSchema>, ExclusionKind>>();
same<Same<z.infer<typeof rootModeSchema>, LibraryRootMode>>();
same<Same<z.infer<typeof jobKindSchema>, JobKind>>();

/** 查询串里的类型：kind=all 或 kind=comic,screenshot；有未知值返回 400 */
export const qKinds = z.union([z.literal('all'), qList(contentKindSchema)]);
/** 收拢组图：同一组只占一格。'auto' = 结果超过 AUTO_COLLAPSE_MIN 张才收拢 */
const qCollapse = z.union([z.literal('auto'), qBool]);

// ---------------------------------------------------------------- 作品、角色、搜索

/** GET /api/works?sort= */
export const listWorksQuery = z.object({ sort: z.enum(['imageCount', 'recent', 'name']).optional() });

/** 作品筛选；特殊值 `recent` = 最近 30 天有新增的 */
const workFilter = z.string().min(1).optional();

/** GET /api/characters */
export const listCharactersQuery = z.object({
  workId: workFilter,
  /** 按名字 / 别名 / Danbooru 标签 / 作品名模糊搜索 */
  q: z.string().optional(),
  sort: z.enum(['imageCount', 'recent', 'name', 'newCount']).optional(),
  source: characterSourceSchema.optional(),
  /** 也列出「只出现在非插画里」的角色（默认隐藏） */
  includeOther: qBool.optional(),
  cursor: z.string().optional(),
  /** 默认 60，最大 200 */
  limit: qNumber.min(1).max(200).optional(),
});

/** GET /api/characters/top?limit=9 —— 「你最常看的」，按收藏张数排序 */
export const topCharactersQuery = z.object({ limit: qNumber.min(1).max(50).optional(), workId: workFilter });

/** GET /api/characters/:id/cover-candidates?limit=12 —— 「换封面」面板（CB-7）；默认 12，最多 48 */
export const coverCandidatesQuery = z.object({ limit: qNumber.min(1).max(48).optional() });

/** POST /api/characters —— 新建自建角色 */
export const createCharacterBody = z.object({
  name: z.string().min(1).max(100),
  workIds: z.array(z.string()).default([]),
  aliases: z.array(z.string()).optional(),
  danbooruTag: z.string().nullable().optional(),
});

/** PATCH /api/characters/:id */
export const updateCharacterBody = z.object({
  name: z.string().max(100).optional(),
  aliases: z.array(z.string()).optional(),
  danbooruTag: z.string().nullable().optional(),
  workIds: z.array(z.string()).optional(),
  coverImageId: z.string().nullable().optional(),
  coverFocus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
  pinned: z.boolean().optional(),
});

/** POST /api/characters/:id/merge —— 把 :id 合并进 targetId */
export const mergeCharacterBody = z.object({ targetId: z.string().min(1) });

/** GET /api/search?q=&limit=20 */
export const searchQuery = z.object({ q: z.string().default(''), limit: qNumber.min(1).max(50).optional() });

/** GET /api/tags?q=&limit=20 —— 一般标签联想（自定义画面用）；q 为空 = 最常见的 */
export const tagSuggestionsQuery = z.object({ q: z.string().max(100).default(''), limit: qNumber.min(1).max(50).optional() });

/** GET /api/search/phrase?q= —— 把一句话拆成标签（图库搜索框的「按标签」） */
export const tagPhraseQuery = z.object({ q: z.string().max(100).default('') });

// ---------------------------------------------------------------- 图片

/** 自定义画面的标签列表 */
const tagList = qList(z.string().min(1).max(100)).refine((a) => a.length <= CUSTOM_THEME_LIMITS.tags, '标签太多');

/** GET /api/images */
export const listImagesQuery = z.object({
  characterId: z.string().optional(),
  workId: z.string().optional(),
  status: imageStatusSchema.optional(),
  rating: qList(ratingSchema).optional(),
  /** 文件名 / 标签搜索 */
  q: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
  /** 画面（多归属，只看识别过的图的标签） */
  theme: z.enum(BROWSE_THEMES).optional(),
  /** 自定义画面：有其中任一一般标签（分数达到 TAG_FILTER_MIN_SCORE）的图 */
  tags: tagList.optional(),
  /** 自定义画面：必含，这些标签每个都要有 */
  tagsAll: tagList.optional(),
  /** 自定义画面：这些标签一个都不能有 */
  tagsNone: tagList.optional(),
  favorite: qBool.optional(),
  /** true = 用户归为原创的图；false = 没归为原创的 */
  original: qBool.optional(),
  /** 内容类型；不传或 'all' = 全部类型 */
  kind: qKinds.optional(),
  /** true = 分级可信（识别过，或手动设过分级） */
  rated: qBool.optional(),
  /** 随机排序的种子（0–1073741823），只在 sort='random' 时生效：同一个种子结果相同 */
  seed: qNumber.min(0).max(1073741823).optional(),
  /** page = 合集里的页序，只在 collectionId 是具体 id 时有效，否则当 addedAt */
  sort: z.enum(['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random', 'page']).optional(),
  /** 合集：具体 id = 这一本的页；'none' = 不在任何合集里的图（T38c） */
  collectionId: z.string().min(1).optional(),
  /** 收拢组图：同一组只占一格。'auto' = 结果超过 AUTO_COLLAPSE_MIN 张才收拢 */
  collapseCollections: qCollapse.optional(),
  /** 收拢时 memberIds 给整组可见成员，而不是只给命中筛选的（首页「最新入库」） */
  includeWholeCollections: qBool.optional(),
  /** 只看这些图（组图详情从筛选结果点进来时用） */
  imageIds: qList(z.string()).optional(),
  /** 构图相近的候选（给组图手动加图用，复用查重的 dHash 范围） */
  similarTo: z.string().optional(),
  /** 画师（合集页「画师」里的 tag）：识别出这位画师的图，同一个人的不同标签一起算 */
  artist: z.string().min(1).max(200).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  /** 默认 60，最大 200 */
  limit: qNumber.min(1).max(200).optional(),
});

/** 来源：确认一个链接；null 是有意清空；'auto' 恢复按文件名识别 */
export const sourceEditSchema = z.union([
  z.object({
    url: z.string().trim().min(1).max(4000).refine((value) => {
      try {
        const u = new URL(value);
        return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
      } catch {
        return false;
      }
    }, '请输入不含登录凭证的 HTTP 或 HTTPS 来源链接'),
    artist: z.string().trim().max(200).optional(),
  }),
  z.null(),
  z.literal('auto'),
]);

/** PATCH /api/images/:id */
export const updateImageBody = z.object({
  source: sourceEditSchema.optional(),
  characterIds: z.array(z.string()).optional(),
  rating: ratingSchema.optional(),
  favorite: z.boolean().optional(),
  /** 'auto' = 清掉手动设置，按规则重判 */
  kind: z.union([contentKindSchema, z.literal('auto')]).optional(),
});

/** POST /api/images/bulk */
export const bulkImagesBody = z.object({
  ids: z.array(z.string()).min(1).max(5000),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('assign'), characterId: z.string() }),
    z.object({ type: z.literal('unassign'), characterId: z.string() }),
    z.object({ type: z.literal('exclude') }),
    z.object({ type: z.literal('restore') }),
    z.object({ type: z.literal('favorite'), value: z.boolean() }),
    /** 放下：不找角色了，不再出现在未识别（T34a）；false = 放回 */
    z.object({ type: z.literal('shelve'), value: z.boolean() }),
    /** 归为原创（true）/ 移出原创（false）：挂到「原创」作品、离开未识别 */
    z.object({ type: z.literal('original'), value: z.boolean() }),
    z.object({ type: z.literal('rating'), value: ratingSchema }),
    /** 改内容类型；'auto' = 恢复自动判断 */
    z.object({ type: z.literal('kind'), value: z.union([contentKindSchema, z.literal('auto')]) }),
    /** 移到系统回收站（不是永久删除） */
    z.object({ type: z.literal('trash') }),
    /**
     * 手动改画师：add 加上、remove 去掉、set 换成这几位（空 = 没有画师）。artists 是标签（Artist.tag / ImageArtist.tags）
     * 或新名字（服务端规范成小写、空格换下划线）。改过的图之后识别不再动它
     */
    z.object({
      type: z.literal('artist'),
      mode: z.enum(['add', 'remove', 'set']),
      artists: z.array(z.string().trim().min(1).max(200)).max(10),
    }),
    /** 画师改回自动识别：清掉手动改的，交给「识别画师」重新认 */
    z.object({ type: z.literal('artist-auto') }),
  ]),
});

/**
 * POST /api/images/move —— 把图移到图库里的某个文件夹（磁盘上真的移动），识别和整理结果都保留，可撤销。
 * 合集（本子、画集）里的页不移动；重名的自动改成「a (1).jpg」。
 */
const moveFields = z.object({
  /** 二选一：选中的图，或某个角色的全部图 */
  ids: z.array(z.string()).min(1).max(50000).optional(),
  characterId: z.string().optional(),
  /** 目标：图库文件夹 + 里面的子目录（'' = 图库文件夹本身），不存在会新建 */
  rootId: z.string().min(1),
  dir: z.string().max(400),
});
/** 按角色移动时前端先拿 preview 的 ids 再提交，服务端只移确认过的这些：ids 和 characterId 只能给一个 */
export const moveImagesBody = moveFields.refine((b) => (b.ids === undefined) !== (b.characterId === undefined), '要么给 ids，要么给 characterId');
/** 预览可以 ids + characterId 一起给（选中的图里有几张还属于别的角色） */
export const movePreviewBody = moveFields.refine((b) => b.ids !== undefined || b.characterId !== undefined, '要么给 ids，要么给 characterId');

/** POST /api/images/import —— 把下载好的本地文件复制进已有的图库文件夹 */
export const importImagesBody = z.object({
  rootId: z.string().min(1).max(100),
  /** 目标子目录；'' = 图库文件夹本身 */
  dir: z.string().max(200).default(''),
  /** 只在用户要保留同名文件的两个版本时传 */
  keepBoth: z.boolean().optional(),
  files: z.array(z.object({ path: z.string().min(1).max(4000), fileName: z.string().min(1).max(200).optional() })).min(1).max(20),
});

/** POST /api/images/:id/replace —— 换成新版本，保留图片 id 和整理结果 */
export const replaceImageBody = z.object({ path: z.string().min(1).max(4000) });

// ---------------------------------------------------------------- 未识别、重复、排除

/** GET /api/unrecognized —— 参数和大类不匹配时一律忽略，不报错 */
export const listUnrecognizedQuery = z.object({
  cursor: z.string().optional(),
  /** 默认 60，最大 200 */
  limit: qNumber.min(1).max(200).optional(),
  /** 默认 'art' */
  area: z.enum(UNRECOGNIZED_AREAS).optional(),
  /** 只对 art 有效；不传 = 有建议 + 没认出 + 待识别，不含放下的。total 是所请求分段的数量 */
  bucket: z.enum(UNRECOGNIZED_BUCKETS).optional(),
  /** 只在 art + bucket='unsure' 时有效 */
  theme: z.enum(UNRECOGNIZED_THEMES).optional(),
  /** 只对 annex 有效；不传 = 五类合起来 */
  kind: z.enum(UNRECOGNIZED_ANNEX_KINDS).optional(),
  /** 只对 art 有效：只看插画或只看漫画，total 和三个分段计数也只算这一类。不传 = 两种都要 */
  artKind: z.enum(UNRECOGNIZED_ART_KINDS).optional(),
  /** 同 listImagesQuery.collapseCollections */
  collapseCollections: qCollapse.optional(),
});

/** GET /api/unrecognized/summary —— 传了 artKind 以后 art 的 total / 分段 / themes 只算这一类；retaggable、art.kinds、annex 不变 */
export const unrecognizedSummaryQuery = z.object({ artKind: z.enum(UNRECOGNIZED_ART_KINDS).optional() });

/**
 * POST /api/unrecognized/:imageId/accept —— 采纳一个建议（可能会新建角色）；
 * 传 danbooruTags 时一次采纳这张图的多个建议，只有一条撤销
 */
export const acceptSuggestionBody = z.union([
  z.object({ danbooruTag: z.string().min(1) }),
  z.object({ danbooruTags: z.array(z.string().min(1)).min(1).max(20) }),
]);

/** GET /api/duplicates?resolved=false */
export const listDuplicatesQuery = z.object({ resolved: qBool.optional() });

/** POST /api/duplicates/:id/resolve —— 保留 keepIds，其余移入回收站 */
export const resolveDuplicateBody = z.object({
  keepIds: z.array(z.string()).min(1),
  /** 「全部处理」一次点下去的各组传同一个值：在「最近 5 次可撤销」里只算一次 */
  batch: z.string().min(1).max(100).optional(),
});

/** POST /api/exclusions */
export const createExclusionBody = z.object({ kind: exclusionKindSchema, target: z.string().min(1) });

// ---------------------------------------------------------------- 合集、画师

/** GET /api/collections */
export const listCollectionsQuery = z.object({
  kind: collectionKindSchema.optional(),
  characterId: z.string().optional(),
  workId: z.string().optional(),
  seriesKey: z.string().optional(),
  pending: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().optional(),
});

/** POST /api/collections：fromImageId = 这张图所在的文件夹做成合集；imageIds = 收录任意几张（组图） */
export const createCollectionBody = z
  .object({
    /** 这张图所在的文件夹做成合集 */
    fromImageId: z.string().optional(),
    /** 收录这些图（可以来自不同文件夹） */
    imageIds: z.array(z.string()).min(1).max(5000).optional(),
    /** 同时把文件移到子文件夹里（默认只改图库里的关系） */
    organizeFiles: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    kind: collectionKindSchema,
  })
  .refine((b) => !!b.fromImageId || !!b.imageIds?.length, '请选择图片');

/** PATCH /api/collections/:id */
export const updateCollectionBody = z.object({
  /** 同时把文件移到子文件夹里 */
  organizeFiles: z.boolean().optional(),
  /** 组图增删成员 */
  addImageIds: z.array(z.string()).min(1).max(5000).optional(),
  removeImageIds: z.array(z.string()).min(1).max(5000).optional(),
  /** null = 恢复自动名 */
  title: z.string().trim().min(1).max(200).nullable().optional(),
  kind: z.union([collectionKindSchema, z.literal('auto')]).optional(),
  coverImageId: z.string().nullable().optional(),
  pageOrder: z.enum(['name', 'mtime']).optional(),
  /** null = 恢复自动 */
  seriesKey: z.string().max(200).nullable().optional(),
  volumeNo: z.number().min(0).max(9999).nullable().optional(),
  reviewed: z.boolean().optional(),
  manualCharacterIds: z.array(z.string()).max(200).optional(),
  manualWorkIds: z.array(z.string()).max(200).optional(),
});

/** POST /api/collections/bulk */
export const bulkCollectionsBody = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('review') }),
    z.object({ type: z.literal('addCharacter'), characterId: z.string() }),
    z.object({ type: z.literal('addWork'), workId: z.string() }),
    z.object({ type: z.literal('kind'), value: collectionKindSchema }),
  ]),
});

/**
 * POST /api/artists/links —— 自动合并猜错了时手动改：
 * split = 这些标签各自单独算一个人；merge = 这些标签并到 into 所在的人；auto = 去掉这些标签的手动设置
 */
export const updateArtistLinksBody = z.object({
  tags: z.array(z.string().min(1).max(200)).min(1).max(50),
  mode: z.enum(['split', 'merge', 'auto']),
  /** merge 时：并到哪位画师（他的标签） */
  into: z.string().min(1).max(200).optional(),
});

// ---------------------------------------------------------------- 设置、图库文件夹、任务、撤销

const themeTags = z.array(z.string().trim().min(1).max(100)).max(CUSTOM_THEME_LIMITS.tags);

/** PUT /api/settings —— 深合并；libraryRoots 用单独的接口改 */
export const updateSettingsBody = z.object({
  tagger: z
    .object({
      model: z.string(),
      device: z.enum(['cpu', 'dml']),
      generalThreshold: z.number().min(0).max(1),
      characterThreshold: z.number().min(0).max(1),
      autoAcceptThreshold: z.number().min(0).max(1),
      batchSize: z.number().int().min(1).max(64),
      legacyModel: z.string().nullable(),
      legacyBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      skipCameraPhotos: z.boolean(),
      retryOld: z.boolean(),
      keepAwake: z.boolean(),
      artists: z.boolean(),
      pixiv: z.boolean(),
      pixivFilenameMode: z.enum(['strict', 'broad']),
      comicInUnrecognized: z.boolean(),
    })
    .partial()
    .optional(),
  danbooru: z.object({ enabled: z.boolean(), username: z.string() }).partial().optional(),
  dedupe: z.object({ hammingThreshold: z.number().int().min(0).max(64) }).partial().optional(),
  ui: z
    .object({
      theme: z.enum(['system', 'light', 'dark']),
      blurSensitive: z.boolean(),
      density: z.enum(['comfortable', 'compact']),
    })
    .partial()
    .optional(),
  browse: z
    .object({
      customThemes: z
        .array(
          z
            .object({
              id: z.string().min(1).max(64),
              name: z.string().trim().min(1).max(CUSTOM_THEME_LIMITS.name),
              tags: themeTags,
              all: themeTags.optional(),
              none: themeTags.optional(),
            })
            .refine((t) => t.tags.length + (t.all?.length ?? 0) > 0, '至少要有一个「必含」或「任一」标签')
            .refine((t) => t.tags.length + (t.all?.length ?? 0) + (t.none?.length ?? 0) <= CUSTOM_THEME_LIMITS.tags, '标签太多'),
        )
        .max(CUSTOM_THEME_LIMITS.themes),
    })
    .partial()
    .optional(),
  /** 只在设置时传，读取时永远不回显 */
  danbooruApiKey: z.string().optional(),
});

/** POST /api/library-roots */
export const addLibraryRootBody = z.object({
  path: z.string().min(1),
  /** 新文件夹包含图库里已有的文件夹时，确认合并成一个（不传则返回 needs_confirm） */
  merge: z.boolean().optional(),
  /** comic = 按漫画导入（跳过识别）；不传 = auto */
  mode: rootModeSchema.optional(),
  /** 按漫画导入时页面的分级；不传 = general */
  comicRating: ratingSchema.optional(),
});

/** PATCH /api/library-roots/:id */
export const updateLibraryRootBody = z
  .object({
    enabled: z.boolean().optional(),
    mode: rootModeSchema.optional(),
    comicRating: ratingSchema.optional(),
    /** 把里面的一个子文件夹按漫画导入（已经是的话改分级） */
    comicFolder: z.object({ relDir: z.string().min(1).max(1000), comicRating: ratingSchema.optional() }).optional(),
    /** 子文件夹不再按漫画导入 */
    removeComicFolder: z.string().min(1).max(1000).optional(),
  })
  .refine(
    (b) => b.enabled !== undefined || b.mode !== undefined || b.comicRating !== undefined || b.comicFolder !== undefined || b.removeComicFolder !== undefined,
    '没有要改的',
  );

/** POST /api/jobs */
export const startJobBody = z.object({
  kind: jobKindSchema,
  /** 仅 pixiv-tags：重新获取待补投稿的标签；默认复用缓存。 */
  refreshPixiv: z.boolean().optional(),
});

/** GET / POST /api/settings/source-mode：Pixiv 投稿号识别方式 */
export const sourceModeParams = z.object({ mode: z.enum(['strict', 'broad']) });

/** GET /api/changes?group=auto|move */
export const listChangesQuery = z.object({ group: z.enum(['auto', 'move']) });

/** POST /api/undo/status：问一批 token 现在还能不能撤销（助手勘误条用）；一次最多问 500 个 */
export const undoStatusBody = z.object({ tokens: z.array(z.string().min(1).max(100)).max(500) });
