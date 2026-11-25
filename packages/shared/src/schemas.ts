/**
 * 命令和查询的输入 schema（zod，docs/core-architecture.md 第 4.1、9 节）：HTTP、MCP、前端共用这一份，不再在路由文件、助手工具里各抄一份（附录 #35）。
 * 服务端的命令 / 查询注册表（apps/server/src/commands/）用它校验输入；HTTP 路由、MCP 工具的参数和枚举都从注册表来。
 *
 * 单独的入口 `@emaki/shared/schemas`：网页只按需引类型，不把 zod 打进首屏。
 * 查询的输入要能直接收查询串（全是字符串），所以数字、布尔、列表都同时认原生值和字符串（q* 这几个）。
 */
import { z } from 'zod';
import { STARTABLE_JOB_KINDS } from './jobs.ts';
import {
  BROWSE_THEMES,
  CUSTOM_THEME_LIMITS,
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_AREAS,
  UNRECOGNIZED_ART_KINDS,
  UNRECOGNIZED_BUCKETS,
  UNRECOGNIZED_THEMES,
} from './api.ts';
import { DEVICE_GRANTABLE_SCOPES, type Scope } from './commands.ts';
import {
  CONTENT_KINDS,
  type CharacterSource,
  type CollectionKind,
  type CollectionMembership,
  type ContentKind,
  type ExclusionKind,
  type ImageStatus,
  type LibraryRootMode,
  type Rating,
} from './domain.ts';
import { NAV_ICONS, NAV_SECTIONS } from './plugins.ts';
import { POSEWEAR_POSE_ID } from './pose.ts';

/** shared 不带 DOM / node 的类型：这里只用到 URL 的这几个字段（运行时是全局的 URL） */
declare const URL: new (url: string) => { protocol: string; username: string; password: string };

// ------------------------------------------------------------------ 基本的

/** 查询串里的整数（也认数字） */
export const qNumber = z.coerce.number().int();
/** 查询串里的布尔值：true/false/1/0（也认布尔） */
export const qBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]);
/** 查询串里逗号分隔的列表：rating=general,sensitive（也认数组） */
export const qList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z.union([
    z.array(item),
    z
      .string()
      .transform((s) => s.split(',').filter(Boolean))
      .pipe(z.array(item)),
  ]);

export const Id = z.string().min(1);
/** 姿势类别的 id：full_01 这样 */
const POSE_CLASS_ID = /^[a-z]+_\d{2}$/;
export const IdInput = z.object({ id: Id });
export const RatingSchema = z.enum(['general', 'sensitive', 'questionable', 'explicit']);
const animatedIsNotKind = (issue: { input?: unknown }) =>
  issue.input === 'animated' ? '「动图」不是类型了：是不是动图按帧数自动判断（筛选用 animated=true），不能当类型选' : undefined;
/** 内容类型（D5 起没有 animated：动图是另一个维度，筛选用 animated=true） */
export const KindSchema = z.enum(CONTENT_KINDS as readonly [ContentKind, ...ContentKind[]], { error: animatedIsNotKind });
/** 改类型：'auto' = 清掉手动设置，按规则重判 */
export const KindValue = z.enum([...CONTENT_KINDS, 'auto'] as unknown as [ContentKind | 'auto', ...(ContentKind | 'auto')[]], {
  error: animatedIsNotKind,
});
/** 查询串里的类型：kind=all 或 kind=comic,screenshot；有未知值返回 400 */
export const qKinds = z.union([z.literal('all'), qList(KindSchema)]);
export const CollectionKindSchema = z.enum(['doujin', 'artbook', 'group']);
/** 合集的成员怎么来的：folder = 按文件夹成册，selection = 手动挑的，post = 同一投稿自动收拢 */
export const CollectionMembershipSchema = z.enum(['folder', 'selection', 'post']);
export const RootModeSchema = z.enum(['auto', 'comic']);
export const ExclusionKindSchema = z.enum(['image', 'folder', 'tag', 'character']);
export const ImageStatusSchema = z.enum(['recognized', 'unrecognized', 'excluded']);
export const CharacterSourceSchema = z.enum(['danbooru', 'custom']);

/** 两个类型完全相同时是 true：保证这里的枚举和 domain.ts 一致，哪边多一个、少一个值都编译不过（上游 303f138） */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>() => undefined as unknown as T;
same<Same<z.infer<typeof RatingSchema>, Rating>>();
same<Same<z.infer<typeof KindSchema>, ContentKind>>();
same<Same<z.infer<typeof CollectionKindSchema>, CollectionKind>>();
same<Same<z.infer<typeof CollectionMembershipSchema>, CollectionMembership>>();
same<Same<z.infer<typeof RootModeSchema>, LibraryRootMode>>();
same<Same<z.infer<typeof ExclusionKindSchema>, ExclusionKind>>();
same<Same<z.infer<typeof ImageStatusSchema>, ImageStatus>>();
same<Same<z.infer<typeof CharacterSourceSchema>, CharacterSource>>();

/** 一批图片（批量操作可能带几千个 id） */
export const ImageIds = z.array(z.string()).min(1).max(5000);
const tagName = z.string().trim().min(1).max(200);

// ------------------------------------------------------------------ 归类（curate）

/**
 * curation.link：把角色关联到这些图（手动的决定，清掉否决，D3）。
 * characterId 是已有的角色；tags 是标签（Danbooru 标签或建议里的标签），找不到角色时按建议建档。
 * accept：采纳这张图的建议（未识别页的「采纳」）——按这张图的证据记来历，只能一张图
 */
export const LinkInput = z
  .object({
    ids: ImageIds,
    characterId: z.string().optional(),
    tags: z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional(),
    accept: z.boolean().optional(),
  })
  .refine((b) => (b.characterId === undefined) !== (b.tags === undefined), '要么给 characterId，要么给 tags')
  .refine((b) => !b.accept || (b.tags !== undefined && b.ids.length === 1), '采纳建议只能是一张图的标签');
export const UnlinkInput = z.object({ ids: ImageIds, characterId: z.string() });
/** 整组替换一张图的角色：去掉的记否决，新加的是手动，本来就有的保持原来的来历 */
export const ReplaceCharactersInput = z.object({ id: Id, characterIds: z.array(z.string()).max(200) });
export const SetFavoriteInput = z.object({ ids: ImageIds, value: z.boolean() });
export const SetRatingInput = z.object({ ids: ImageIds, value: RatingSchema });
export const SetKindInput = z.object({
  ids: ImageIds,
  value: KindValue.describe('内容类型；是否动图不是类型（按帧数自动判断，图片的 animated 字段），不能改'),
});
/** 放下：不找角色了，不再出现在未识别；false = 放回 */
export const SetShelvedInput = z.object({ ids: ImageIds, value: z.boolean() });
/** 归为原创（true）/ 移出原创（false） */
export const SetOriginalInput = z.object({ ids: ImageIds, value: z.boolean() });
export const SetArtistsInput = z.object({
  ids: ImageIds,
  mode: z.enum(['add', 'remove', 'set']),
  artists: z.array(z.string().trim().min(1).max(200)).max(10),
});
/** 画师改回自动识别 */
export const ImagesInput = z.object({ ids: ImageIds });
/** 来源：{url, artist?} 人工确认；null 清除并锁定为空；'auto' 解除锁定、按文件名重算 */
export const SourceEdit = z.union([
  z.object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine((value) => {
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
export const SetSourceInput = z.object({ id: Id, source: SourceEdit });
/** 按当前阈值补采纳（可以只看某一类） */
export const PromoteInput = z.object({ kind: KindSchema.optional() });

// ------------------------------------------------------------------ 可见性

export const CreateExclusionInput = z.object({ kind: ExclusionKindSchema, target: z.string().min(1) });

// ------------------------------------------------------------------ 编目（catalog）

export const CreateCharacterInput = z.object({
  name: z.string().min(1).max(100),
  workIds: z.array(z.string()).default([]),
  aliases: z.array(z.string()).optional(),
  danbooruTag: z.string().nullable().optional(),
});
export const UpdateCharacterFields = z.object({
  name: z.string().max(100).optional(),
  aliases: z.array(z.string()).optional(),
  danbooruTag: z.string().nullable().optional(),
  workIds: z.array(z.string()).optional(),
  coverImageId: z.string().nullable().optional(),
  coverFocus: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable()
    .optional(),
  pinned: z.boolean().optional(),
});
export const UpdateCharacterInput = UpdateCharacterFields.extend({ id: Id });
export const MergeCharacterInput = z.object({ id: Id, targetId: z.string().min(1) });

const verifiedTag = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s:]+$/);
const verificationEvidence = {
  aliases: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  sources: z
    .array(z.url({ protocol: /^https?$/ }).max(2000))
    .min(1)
    .max(8),
  evidence: z.string().trim().min(1).max(2000),
};
/** 查证过的角色身份关系或常用名 */
export const CharacterVerificationInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('identity'),
    tag: verifiedTag,
    characterTag: verifiedTag,
    relation: z.enum(['form', 'same-character']),
    ...verificationEvidence,
  }),
  z.object({ type: z.literal('name'), tag: verifiedTag, name: z.string().trim().min(1).max(100), ...verificationEvidence }),
]);
export type CharacterVerification = z.infer<typeof CharacterVerificationInput>;

/** 画师：split 各自单独算一个人；merge 并到 into 所在的人；auto 去掉这些标签的手动设置 */
export const ArtistLinksInput = z.object({
  tags: z.array(z.string().min(1).max(200)).min(1).max(50),
  mode: z.enum(['split', 'merge', 'auto']),
  into: z.string().min(1).max(200).optional(),
});

// ------------------------------------------------------------------ 合集

export const CreateCollectionInput = z
  .object({
    fromImageId: z.string().optional(),
    imageIds: z.array(z.string()).min(1).max(5000).optional(),
    organizeFiles: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    /** 不给是组图 */
    kind: CollectionKindSchema.default('group'),
  })
  .refine((b) => !!b.fromImageId || !!b.imageIds?.length, '请选择图片');
export const UpdateCollectionFields = z.object({
  organizeFiles: z.boolean().optional(),
  addImageIds: z.array(z.string()).min(1).max(5000).optional(),
  removeImageIds: z.array(z.string()).min(1).max(5000).optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  kind: z.union([CollectionKindSchema, z.literal('auto')]).optional(),
  coverImageId: z.string().nullable().optional(),
  pageOrder: z.enum(['name', 'mtime']).optional(),
  seriesKey: z.string().max(200).nullable().optional(),
  volumeNo: z.number().min(0).max(9999).nullable().optional(),
  reviewed: z.boolean().optional(),
  manualCharacterIds: z.array(z.string()).max(200).optional(),
  manualWorkIds: z.array(z.string()).max(200).optional(),
});
export const UpdateCollectionInput = UpdateCollectionFields.extend({ id: Id });
export const CollectionIds = z.array(z.string()).min(1).max(500);
export const CollectionsInput = z.object({ ids: CollectionIds });
export const SetCollectionKindInput = z.object({ ids: CollectionIds, value: CollectionKindSchema });
/** 合集的出场角色 / 作品（合集模块的事实，不是图 ↔ 角色）：characterId、tag（按建议建档）、workId 三选一 */
export const LinkCollectionsInput = z
  .object({
    ids: CollectionIds,
    characterId: z.string().optional(),
    tag: z.string().trim().min(1).max(200).optional(),
    workId: z.string().optional(),
  })
  .refine((b) => [b.characterId, b.tag, b.workId].filter((x) => x !== undefined).length === 1, 'characterId、tag、workId 三选一');

// ------------------------------------------------------------------ 图库与文件

export const ImportImagesInput = z.object({
  rootId: z.string().min(1).max(100),
  dir: z.string().max(200).default(''),
  keepBoth: z.boolean().optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(4000), fileName: z.string().min(1).max(200).optional() }))
    .min(1)
    .max(20),
});
export const ReplaceImageInput = z.object({ id: Id, path: z.string().min(1).max(4000) });
/** 按角色移动时前端先拿 preview 的 ids 再提交，服务端只移确认过的这些 */
const moveFields = {
  ids: z.array(z.string()).min(1).max(50000).optional(),
  characterId: z.string().optional(),
  rootId: z.string().min(1),
  dir: z.string().max(400),
};
export const MoveImagesInput = z
  .object(moveFields)
  .refine((b) => (b.ids === undefined) !== (b.characterId === undefined), '要么给 ids，要么给 characterId');
export const MovePreviewInput = z
  // GET 的查询串里空的 dir 不出现：不给就是图库文件夹本身
  .object({
    ...moveFields,
    ids: qList(z.string()).pipe(z.array(z.string()).min(1).max(50000)).optional(),
    dir: z.string().max(400).default(''),
  })
  .refine((b) => b.ids !== undefined || b.characterId !== undefined, '要么给 ids，要么给 characterId');
export const AddRootInput = z.object({
  path: z.string().min(1),
  merge: z.boolean().optional(),
  mode: RootModeSchema.optional(),
  comicRating: RatingSchema.optional(),
});
export const UpdateRootFields = z.object({
  enabled: z.boolean().optional(),
  mode: RootModeSchema.optional(),
  comicRating: RatingSchema.optional(),
  comicFolder: z.object({ relDir: z.string().min(1).max(1000), comicRating: RatingSchema.optional() }).optional(),
  removeComicFolder: z.string().min(1).max(1000).optional(),
});
export const UpdateRootInput = UpdateRootFields.extend({ id: Id }).refine(
  (b) =>
    b.enabled !== undefined ||
    b.mode !== undefined ||
    b.comicRating !== undefined ||
    b.comicFolder !== undefined ||
    b.removeComicFolder !== undefined,
  '没有要改的',
);

// ------------------------------------------------------------------ 查重

/** 至少保留一张：由查重模块报（「至少保留一张」），schema 只管形状 */
export const ResolveDuplicateInput = z.object({ id: Id, keepIds: z.array(z.string()), batch: z.string().min(1).max(100).optional() });

// ------------------------------------------------------------------ 设置

const themeTags = z.array(z.string().trim().min(1).max(100)).max(CUSTOM_THEME_LIMITS.tags);
export const UpdateSettingsInput = z.object({
  tagger: z
    .object({
      model: z.string(),
      device: z.enum(['cpu', 'dml']),
      generalThreshold: z.number().min(0).max(1),
      characterThreshold: z.number().min(0).max(1),
      autoAcceptThreshold: z.number().min(0).max(1),
      // 按来源的自动阈值：tagger、pixiv，以后的插件来源 plugin:<id>
      autoAcceptBySource: z.record(z.string().regex(/^(tagger|pixiv|plugin:[\w.-]+)$/), z.number().min(0).max(1)),
      batchSize: z.number().int().min(1).max(64),
      legacyModel: z.string().nullable(),
      legacyBefore: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
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
  dedupe: z
    .object({ hammingThreshold: z.number().int().min(0).max(64) })
    .partial()
    .optional(),
  // blurSensitive、density 是本机偏好（P5，附录 #32），收到也丢掉
  ui: z
    .object({ theme: z.enum(['system', 'light', 'dark']) })
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
  pose: z.object({ enabled: z.boolean(), showClasses: z.boolean() }).partial().optional(),
  danbooruApiKey: z.string().optional(),
});
export const SourceModeInput = z.object({ mode: z.enum(['strict', 'broad']) });

// ------------------------------------------------------------------ 后台任务、撤销

export const StartJobInput = z.object({
  kind: z.enum(STARTABLE_JOB_KINDS),
  refreshPixiv: z.boolean().optional().describe('仅 pixiv-tags：主动重新获取标签；默认复用投稿缓存'),
});
export const UndoInput = z.object({ token: z.string().min(1) });
/** 一次最多问 500 个，一个会话的勘误条够用了 */
export const UndoStatusInput = z.object({ tokens: qList(z.string().min(1).max(100)).pipe(z.array(z.string()).max(500)) });
export const EmptyInput = z.object({});

// ------------------------------------------------------------------ 设备与访问（docs/mobile.md 第 2 节）

/** 设备名称、电脑名称 */
const deviceName = z.string().trim().min(1).max(60);
/** 32 字节随机数的 hex（配对的 commit、nonce） */
const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, '要 64 位 hex').transform((s) => s.toLowerCase());
/** 能授予设备的范围（devices、desktop 不在里面，传了就是 400）；去重 */
export const DeviceScopes = z
  .array(z.enum(DEVICE_GRANTABLE_SCOPES as readonly [Scope, ...Scope[]]))
  .max(30)
  .transform((a) => [...new Set(a)]);

/** POST /api/v1/pair（局域网入口，不要凭证）：普通请求带 commit；扫码带 ticket，不用 commit */
export const PairStartInput = z
  .object({
    name: deviceName,
    model: z.string().trim().max(100).optional(),
    commit: hex32.optional(),
    ticket: z.string().min(1).max(100).optional(),
  })
  .refine((b) => !!b.commit || !!b.ticket, '要带 commit（sha256(nonceA) 的 hex）或 ticket');
/** POST /api/v1/pair/:id/reveal：手机公开自己的随机数 nonceA（hex） */
export const PairRevealInput = z.object({ nonce: hex32 });

/** PATCH /api/access：打开 / 关闭局域网入口、改端口、改电脑名称（null 恢复成计算机名） */
export const AccessConfigureInput = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  name: deviceName.nullable().optional(),
});
/** 批准一个请求：scopes 不给就是默认的（DEVICE_DEFAULT_SCOPES），name 可以改掉手机报的名字 */
export const DeviceApproveInput = z.object({ id: Id, scopes: DeviceScopes.optional(), name: deviceName.optional() });
/** 改设备的名称、权限 */
export const DeviceUpdateInput = z.object({ id: Id, name: deviceName.optional(), scopes: DeviceScopes.optional() });
/** 改设备传上来的图放到哪：rootId 为 null 恢复默认（收件箱/手机/<设备名>） */
export const DeviceUploadInput = z.object({ id: Id, rootId: Id.nullable(), dir: z.string().max(400).default('') });

// ------------------------------------------------------------------ 手机上传（B1，docs/mobile.md 5.4）

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 要是 64 位小写十六进制');
/** 每个文件最多 128 MiB（和导入图片一样） */
export const UPLOAD_MAX_BYTES = 128 * 1024 * 1024;
/** 一段最多 8 MiB（PUT /api/uploads/:id 的请求体） */
export const UPLOAD_CHUNK_MAX = 8 * 1024 * 1024;
export const UploadCheckInput = z.object({ files: z.array(z.object({ sha256: Sha256, size: z.number().int().min(1).max(UPLOAD_MAX_BYTES) })).min(1).max(500) });
export const UploadBeginInput = z.object({
  batchId: z.string().uuid(),
  sha256: Sha256,
  size: z.number().int().min(1).max(UPLOAD_MAX_BYTES),
  fileName: z.string().min(1).max(200),
  /** 手机上的修改时间（ISO），入库后的文件照这个时间 */
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  /** 同步的相册：手机上的文件夹路径（'Download'、'Pictures/bili'）；手动上传不给 */
  album: z.string().min(1).max(300).optional(),
  /** 手机上这个文件的标识（相册同步用 MediaStore 的 id） */
  clientKey: z.string().min(1).max(200).optional(),
});
export const UploadBatchesInput = z.object({ limit: qNumber.min(1).max(100).optional() });

// ------------------------------------------------------------------ 同步相册（B2，docs/mobile.md 5.5）

/** 手机上的相册路径（MediaStore 的 RELATIVE_PATH）：服务端去掉两头的斜杠、反斜杠换成正斜杠 */
const AlbumPath = z.string().min(1).max(300);
const Count = z.number().int().min(0).max(100_000_000);
const Bytes = z.number().int().min(0);
/** 一台设备的同步相册：设备自己问不用给 deviceId；电脑上（本机入口）要给 */
export const AlbumsQueryInput = z.object({ deviceId: Id.optional() });
/** App 报相册（full = 这是手机上全部的相册，没列出的标成「手机上没有了」）、盘点结果、同步状态 */
export const AlbumReportInput = z.object({
  albums: z
    .array(
      z.object({
        path: AlbumPath,
        name: z.string().min(1).max(200),
        count: Count,
        bytes: Bytes,
        latestAt: z.string().datetime({ offset: true }).optional(),
        inventory: z
          .object({
            total: Count,
            have: Count,
            inTarget: Count,
            deleted: Count,
            new: Count,
            newBytes: Bytes,
            folder: z.string().max(400).nullable(),
            folderCount: Count,
          })
          .optional(),
        /** 这次同步完还没传上来的（会再试） */
        pending: Count.optional(),
        /** 电脑读不了的（不再传） */
        rejected: Count.optional(),
      }),
    )
    .max(2000)
    .default([]),
  full: z.boolean().default(false),
  state: z
    .object({
      running: z.enum(['inventory', 'sync']).nullable(),
      done: Count.optional(),
      total: Count.optional(),
      error: z.string().max(500).nullable().optional(),
      summary: z.string().max(500).nullable().optional(),
    })
    .optional(),
});
/** 改同步设置：哪些相册同步、新图放到哪（dir 为 null 恢复自动）；只在 Wi-Fi、只在充电 */
export const AlbumSetInput = z.object({
  deviceId: Id.optional(),
  albums: z
    .array(z.object({ path: AlbumPath, sync: z.boolean().optional(), dir: z.string().max(400).nullable().optional() }))
    .max(2000)
    .default([]),
  wifiOnly: z.boolean().optional(),
  chargingOnly: z.boolean().optional(),
});

// ------------------------------------------------------------------ 查询

const tagList = qList(z.string().min(1).max(100)).refine((a) => a.length <= CUSTOM_THEME_LIMITS.tags, '标签太多');

export const ListImagesInput = z.object({
  characterId: z.string().optional(),
  workId: z.string().optional(),
  status: ImageStatusSchema.optional(),
  rating: qList(RatingSchema).optional(),
  q: z.string().optional(),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
  theme: z.enum(BROWSE_THEMES).optional(),
  tags: tagList.optional(),
  tagsAll: tagList.optional(),
  tagsNone: tagList.optional(),
  favorite: qBool.optional(),
  original: qBool.optional(),
  kind: qKinds.optional(),
  animated: qBool.optional(),
  rated: qBool.optional(),
  seed: qNumber.min(0).max(1073741823).optional(),
  sort: z.enum(['addedAt', 'modifiedAt', 'fileName', 'bytes', 'random', 'page']).optional(),
  collectionId: z.string().min(1).optional(),
  collapseCollections: z.union([z.literal('auto'), qBool]).optional(),
  includeWholeCollections: qBool.optional(),
  imageIds: qList(z.string()).optional(),
  similarTo: z.string().optional(),
  artist: z.string().min(1).max(200).optional(),
  poseClass: z.string().regex(POSE_CLASS_ID).optional(),
  posewearPose: z.string().regex(POSEWEAR_POSE_ID).optional(),
  posewearReliable: qBool.optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  limit: qNumber.min(1).max(200).optional(),
});
export const ThumbInput = z.object({ id: Id, w: qNumber.optional() });
export const ListWorksInput = z.object({ sort: z.enum(['imageCount', 'recent', 'name']).optional() });
const workFilter = z.string().min(1).optional();
export const ListCharactersInput = z.object({
  workId: workFilter,
  q: z.string().optional(),
  sort: z.enum(['imageCount', 'recent', 'name', 'newCount']).optional(),
  source: CharacterSourceSchema.optional(),
  includeOther: qBool.optional(),
  cursor: z.string().optional(),
  limit: qNumber.min(1).max(200).optional(),
});
export const TopCharactersInput = z.object({ limit: qNumber.min(1).max(50).optional(), workId: workFilter });
export const CoverCandidatesInput = z.object({ id: Id, limit: qNumber.min(1).max(48).optional() });
export const SearchInput = z.object({
  q: z.string().default(''),
  limit: qNumber.min(1).max(50).optional(),
  forAssignment: qBool.optional(),
});
export const TagSuggestionsInput = z.object({ q: z.string().max(100).default(''), limit: qNumber.min(1).max(50).optional() });
/** GET /api/search/phrase?q= —— 把一句话拆成标签（图库搜索框的「按标签」） */
export const TagPhraseInput = z.object({ q: z.string().max(100).default('') });
/** 合集列表：kind、membership 可多选（逗号分隔）；sort=recent&limit=50 是最近加图的 50 本 */
export const ListCollectionsInput = z.object({
  kind: qList(CollectionKindSchema).optional(),
  membership: qList(CollectionMembershipSchema).optional(),
  characterId: z.string().optional(),
  workId: z.string().optional(),
  seriesKey: z.string().optional(),
  pending: qBool.optional(),
  q: z.string().optional(),
  sort: z.enum(['title', 'recent']).optional(),
  limit: qNumber.min(1).max(1000).optional(),
});
/** 合集的数目（每一类、每种成员来源）：q 和列表的搜索同一个规则 */
export const CollectionCountsInput = z.object({ q: z.string().optional() });
export const ListUnrecognizedInput = z.object({
  cursor: z.string().optional(),
  limit: qNumber.min(1).max(200).optional(),
  area: z.enum(UNRECOGNIZED_AREAS).optional(),
  bucket: z.enum(UNRECOGNIZED_BUCKETS).optional(),
  theme: z.enum(UNRECOGNIZED_THEMES).optional(),
  kind: z.enum(UNRECOGNIZED_ANNEX_KINDS).optional(),
  artKind: z.enum(UNRECOGNIZED_ART_KINDS).optional(),
  collapseCollections: z.union([z.literal('auto'), qBool]).optional(),
});
export const UnrecognizedSummaryInput = z.object({ artKind: z.enum(UNRECOGNIZED_ART_KINDS).optional() });
export const ListDuplicatesInput = z.object({ resolved: qBool.optional() });
export const ListChangesInput = z.object({ group: z.enum(['auto', 'move']) });
export const AuditInput = z.object({
  limit: qNumber.min(1).max(500).optional(),
  /** 只看这个 actor（user、assistant、job:tag …） */
  actor: z.string().max(100).optional(),
  /** 只看这个命令 */
  command: z.string().max(100).optional(),
  /** 翻页：只看 id 比它小的 */
  before: qNumber.optional(),
});

// ------------------------------------------------------------------ 按姿势找图（实验）

/** 下载姿势模型：要用户明确同意（会从 Hugging Face 下载约 240 MB） */
export const PoseDownloadInput = z.object({ consent: z.literal(true) });
/**
 * 从本机文件夹复制姿势模型：文件夹里要有 dw-ll_ucoco_384.onnx；找人模型（model.onnx + threshold.json）放在同一个文件夹，
 * 或它的 anime_person_v1.1_m / person_detect_v1.1_m 子文件夹里
 */
export const PoseCopyInput = z.object({ path: z.string().min(1).max(1000) });
/** 导入原型算好的姿势标签低分（pose_tags_lowthr.npz）：只导本图库里有的图，已经按现在的识别模型收过的不覆盖 */
export const PoseTagsImportInput = z.object({ path: z.string().min(1).max(1000).describe('原型的 pose_tags_lowthr.npz') });
/** 导入原型的姿势数据（一次性；同样的文件再导一次结果不变） */
export const PoseImportInput = z.object({
  keypointsPath: z.string().min(1).max(1000).describe('原型的 keypoints_lib.npz'),
  assignmentsPath: z.string().min(1).max(1000).describe('原型的 assignments.json'),
});
/** 导入 PoseWear 的线稿（本机的 PoseWear 文件夹；复制进数据目录，不进仓库）。姿势目录随包，不用导 */
export const PoseWearImportInput = z.object({
  path: z.string().min(1).max(1000).describe('PoseWear 文件夹（p/t、p/i 里的线稿，或者平铺的 full_single_P001_front.webp 这样的文件）'),
  viewsPath: z.string().min(1).max(1000).optional().describe('不再需要（代表视角随包）；给了也不用'),
});
/** 重新匹配 PoseWear 姿势：默认只补骨架、标签换过的图；all 全部重算 */
export const PoseRematchInput = z.object({ all: qBool.optional() });
/** 一个 PoseWear 姿势的骨架（画小人用）；view 不给就用代表视角 */
export const PoseWearSkeletonInput = z.object({
  id: z.string().regex(POSEWEAR_POSE_ID),
  view: z.enum(['front', 'high', 'low', 'side', 'diag']).optional(),
});
/** 导入姿势匹配结果：单人、双人各自整批替换，至少给一个（命令里检查） */
export const PoseWearAssignInput = z.object({
  assignmentsPath: z.string().min(1).max(1000).optional().describe('单人：posewear_final 的 assignments_multi_weighted.json（assignments_multi.json、旧的 assignments.json 也认）'),
  pairsPath: z.string().min(1).max(1000).optional().describe('双人：pose-pair tags_v1 的 assignments.json'),
});
export const PoseWearCatalogInput = z.object({ all: qBool.optional() });
export const PoseWearFileInput = z.object({
  size: z.enum(['t', 'i']),
  file: z.string().regex(/^(full_single|full_sexy|upper80v2|pair)_P\d{3}_(front|high|low|side|diag)\.webp$/),
});
export const PoseWearOfInput = z.object({ id: Id });
export const PoseWearLowInput = z.object({ pose: z.string().regex(POSEWEAR_POSE_ID) });
export const PoseClassInput = z.object({ id: z.string().regex(POSE_CLASS_ID) });
export const PoseSimilarInput = z.object({ id: Id, cursor: z.string().optional(), limit: qNumber.min(1).max(200).optional() });

// ---------------------------------------------------------------- 插件（docs/plugins.md 第 9 节）
const PluginId = z.string().min(1).max(80);
const PluginName = z.string().trim().min(1).max(40);
/** 覆盖的值：键是设置注册表里的（OVERRIDES），值在它的选项里；服务端再按 validOverride 逐项检查 */
const OverrideValues = z.record(z.string().max(80), z.string().max(80));
export const PluginsStateInput = z.object({ safe: qBool.optional().describe('安全模式：只看内置插件按原样的结果') });
export const SetPluginEnabledInput = z.object({ id: PluginId, enabled: z.boolean() });
export const RenamePluginInput = z.object({ id: PluginId, name: PluginName.nullable().describe('null = 恢复原名') });
export const PluginIdInput = z.object({ id: PluginId });
/** 插件的设置（setting@1，E5）：只能填清单里登记的；空字符串、null 是清掉 */
export const SetPluginSettingsInput = z.object({
  id: PluginId,
  values: z.record(z.string().max(40), z.string().max(4000).nullable()),
});
export const CreateOverridePluginInput = z.object({
  name: PluginName,
  values: OverrideValues.describe('要覆盖的值，例如 {"images.defaultSort":"modifiedAt"}；能用的键和值见 GET /api/plugins 的 overrides'),
  enabled: z.boolean().optional().describe('默认 true：建好就启用'),
});
export const SetOverrideValuesInput = z.object({ id: PluginId, values: OverrideValues });
export const SetNavInput = z.object({
  sections: z
    .object({ main: z.array(z.string().max(80)).max(100), triage: z.array(z.string().max(80)).max(100), footer: z.array(z.string().max(80)).max(100) })
    .optional()
    .describe('侧栏三段各自的顺序（导航项 id）；没列到的项排在各自那一段的最后'),
  visible: z.record(z.string().max(80), z.boolean()).optional().describe('在不在侧栏显示，只改给出的项'),
});
export const ChooseOverrideInput = z.object({
  key: z.string().max(80),
  plugin: PluginId.nullable().describe('冲突时用哪个插件的值；null = 按后启用的那个'),
});

/** 装的插件的 id：小写字母、数字、-，可以用 . 分段（example.random-browse）；core.、mine.、ai. 开头的留给 Emaki 自己 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}(\.[a-z0-9][a-z0-9-]{0,39}){0,3}$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$|^localhost$/i;

/**
 * 插件清单 emaki-plugin.json 的结构（docs/plugins.md 第 8 节）。只查结构；版本范围、权限能不能给、贡献点认不认识这些
 * 由服务端（domain/plugins/manifest.ts）逐项写成能看懂的话。
 */
export const PluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE, 'id 只能用小写字母、数字、- 和 .，比如 example.random-browse'),
  name: z.string().trim().min(1).max(40),
  version: z.string().max(40),
  description: z.string().max(300).optional(),
  author: z.string().max(80).optional(),
  homepage: z.string().max(300).optional(),
  engines: z.object({ emaki: z.string().max(100).optional() }).optional(),
  permissions: z
    .object({
      scopes: z.array(z.string().max(40)).max(30).optional(),
      folders: z
        .array(z.object({ id: z.string().regex(LOCAL_ID), purpose: z.string().trim().min(1).max(80), suggest: z.string().max(200).optional() }))
        .max(5)
        .optional(),
      network: z.array(z.string().regex(HOST, '要写域名，比如 www.pixiv.net')).max(30).optional(),
      background: z.boolean().optional(),
      unsafe: z.boolean().optional(),
    })
    .optional(),
  contributes: z.record(z.string().max(60), z.unknown()).default({}),
  /** 服务端代码的入口（E5）；具体的检查在服务端（ServerEntrySchema） */
  server: z.string().max(200).optional(),
});

/** nav.item@1（装的插件）：只能指向 Emaki 里的地址（可以带筛选参数），图标从 NAV_ICONS 里选 */
export const InstalledNavItemSchema = z
  .object({
    id: z.string().regex(LOCAL_ID),
    label: z.string().trim().min(1).max(12),
    to: z
      .string()
      .max(300)
      .refine((to) => /^\/(?![/\\])/.test(to) && !/[\s:]/.test(to.split(/[?#]/)[0]!), '只能是 Emaki 里的地址，以 / 开头，比如 /gallery?sort=random')
      .optional(),
    page: z.string().regex(LOCAL_ID).optional().describe('指向这个插件自己的页面（page@1 的 id），不写 to'),
    icon: z.enum(NAV_ICONS).default('puzzle'),
    section: z.enum(NAV_SECTIONS).default('main'),
    hiddenByDefault: z.boolean().optional(),
  })
  .refine((n) => (n.to === undefined) !== (n.page === undefined), { message: 'to 和 page 要写一个，只写一个', path: ['to'] });

/** 包里的相对路径：只用 / 分隔，不能往上跳、不能是绝对路径 */
const PACKAGE_FILE = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/;
/** 服务端逻辑的入口（E5）：包里的 .js / .mjs / .cjs */
export const ServerEntrySchema = z.string().max(200).regex(PACKAGE_FILE, '要写包里的文件，比如 server/index.js').regex(/\.[cm]?js$/, '入口要是 .js、.mjs 或 .cjs');
/** command@1（E5）：名字带插件前缀，在服务端按清单里的插件 id 再查 */
export const InstalledCommandSchema = z.object({
  name: z.string().max(120).regex(/^[a-z0-9][a-z0-9.-]*\.[a-zA-Z][a-zA-Z0-9]{0,39}$/, '命令名写成 <插件 id>.<名字>，比如 pixiv-browser.download'),
  summary: z.string().trim().min(1).max(200),
  scope: z.string().max(40),
  input: z.record(z.string(), z.unknown()).optional(),
});
/** job.kind@1（E5） */
export const InstalledJobKindSchema = z.object({
  kind: z.string().regex(LOCAL_ID),
  label: z.string().trim().min(1).max(20),
});
/** setting@1（E5） */
export const InstalledSettingSchema = z.object({
  id: z.string().regex(LOCAL_ID),
  label: z.string().trim().min(1).max(40),
  type: z.enum(['string', 'secret']).default('string'),
  hint: z.string().trim().max(200).optional(),
});

/** 视图文件：包里的相对路径，.html 结尾，不能往上跳 */
const VIEW_FILE = /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*\.html?$/;
/** 装的插件、AI 做的页面的 page@1：一个视图 */
export const InstalledPageSchema = z.object({
  id: z.string().regex(LOCAL_ID),
  view: z.string().max(200).regex(VIEW_FILE, '视图要写包里的 HTML 文件，比如 views/stats.html'),
  title: z.string().trim().min(1).max(40).optional(),
  site: z.string().regex(LOCAL_ID).optional(),
});
/** site@1（E5）：插件给外部网站用的脚本 */
export const InstalledSiteSchema = z.object({
  id: z.string().regex(LOCAL_ID),
  title: z.string().trim().min(1).max(40),
  url: z.string().max(500).regex(/^https:\/\//, '起始页要是 https 地址'),
  matches: z
    .array(z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9.-]+$/, '写域名，比如 www.pixiv.net'))
    .min(1)
    .max(10),
  script: z.string().max(200).regex(PACKAGE_FILE, '要写包里的文件，比如 site/pixiv.js').regex(/\.js$/, '脚本要是 .js'),
});

const PackageSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), path: z.string().trim().min(1).max(500).describe('这台电脑上的文件夹（开发用：不复制，改了点「重新读取」）') }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).max(500).describe('https://…、ssh://… 或 git@主机:路径'),
    ref: z.string().trim().max(100).optional().describe('分支或标签；不写是默认分支'),
  }),
]);
export const InspectPluginInput = z.object({ source: PackageSource });
export const InstallPluginInput = z.object({
  token: z.string().min(1).max(80),
  folders: z
    .record(z.string().max(40), z.object({ rootId: Id, dir: z.string().max(300) }))
    .optional()
    .describe('授权单上为每个要的文件夹选好的位置'),
  showInNav: z.boolean().optional().describe('它的导航项放不放进侧栏（不给：放进去，和新启用的页面一样）'),
});
export const PluginPackageTokenInput = z.object({ token: z.string().min(1).max(80) });

// ---------------------------------------------------------------- 视图（E4，docs/plugins.md 第 5 节）
export const PluginViewInput = z.object({ id: PluginId, page: z.string().regex(LOCAL_ID) });
/** AI 助手做的页面（docs/plugins.md 5.1）：一个视图，插件 id 是 ai.<name> */
export const SaveAiViewInput = z.object({
  name: z
    .string()
    .regex(LOCAL_ID, '只能用小写字母、数字和 -')
    .describe('页面的英文短名（小写字母、数字、-），插件 id 是 ai.<name>；修改已有的页面用同一个 name'),
  title: PluginName.describe('显示的名字（侧栏、页头、插件页），比如「收藏统计」'),
  description: z.string().trim().max(300).optional().describe('一句话说明这一页看什么'),
  html: z.string().min(1).max(1_000_000).describe('整页 HTML（MCP Apps 视图），写法见工具说明'),
  scopes: z
    .array(z.string().max(40))
    .max(10)
    .default(['read'])
    .describe('页面要调的工具需要的权限范围，默认只读 ["read"]；会改数据的页面才加 curate、collections 等，不能超过助手自己的范围'),
  icon: z.enum(NAV_ICONS).default('chart').describe('侧栏图标'),
});
