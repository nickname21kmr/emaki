/**
 * 命名口径（docs/core-architecture.md 第 6 节，P5，附录 #24–#26）。
 *
 * 「可见」「计入统计」「插画」「待处理队列（按大类）」「待识别」「图的作品」只在这里定义一次。查询、统计、任务、Pixiv 资格都引用这里，
 * 不许在别处内联抄写（test/architecture/terms.test.ts 扫描源码检查，和单一写入者测试一个风格）。
 *
 * 写法约定：
 * - 片段里的别名：i = images（或视图 v_images / v_counted_images），r = library_roots。别名不一样时用带参数的函数版本。
 * - 部分索引（迁移 006、008、038）要求条件字面包含 `trashed_at IS NULL AND missing = 0`、`animated = 1`；
 *   这里拼出来的仍是字面 SQL（不是绑定参数），不要改成参数。
 * - 视图是同一口径的 SQL 版本：v_images = 可见，v_counted_images = 计入统计，v_illust_images = 计入统计的插画，
 *   v_image_works = 图的作品（迁移 002、006、035）。能用视图的地方直接用视图。
 * - 和前端共用的同一条规则（例如「在哪个待处理队列」）在 packages/shared 里有 JS 版本（triageQueue），
 *   两边的一致性由 readmodel/terms.test.ts 逐个组合比对。
 */
import { UNRECOGNIZED_ANNEX_KINDS, UNRECOGNIZED_ART_KINDS, SENSITIVE_RATINGS } from '@emaki/shared';
import { COMIC_AREA_IMAGE_IDS, IN_COMIC } from '../services/classify/comicAreas.ts';

const col = (a: string, c: string) => (a ? `${a}.${c}` : c);
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

// ------------------------------------------------------------------ 可见、计入统计

/** 图库文件夹可见：启用、没移除。a 是 library_roots 的别名（'' = 不带别名） */
export const ROOT_ACTIVE = (a = 'r') => `${col(a, 'enabled')} = 1 AND ${col(a, 'removed_at')} IS NULL`;
/** 可见的图库文件夹的 id */
export const ACTIVE_ROOT_IDS = `SELECT id FROM library_roots WHERE ${ROOT_ACTIVE('')}`;
/**
 * 文件在：没丢、没进回收站（不看图库文件夹）。缩略图、相机这类只关心文件本身的任务用它。
 * 字面是 `missing = 0 AND trashed_at IS NULL`：部分索引 idx_images_live_* 靠它命中
 */
export const FILE_LIVE = (a = 'i') => `${col(a, 'missing')} = 0 AND ${col(a, 'trashed_at')} IS NULL`;
/**
 * 可见（= 视图 v_images）：文件在、所在的图库文件夹可见。被排除的图也算可见（「已排除」页要列它们）。
 * 用法：FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${VISIBLE}
 */
export const VISIBLE = `${FILE_LIVE('i')} AND ${ROOT_ACTIVE('r')}`;
/**
 * 同 VISIBLE，但不用 JOIN library_roots r（T22）：图片列表只查 images 一张表，查询计划才会沿排序索引走、找够一页就停。
 * `+i.root_id` 的加号是故意的：不让 SQLite 拿 root_id 上的索引去驱动查询（那样要先把整个文件夹的图排一遍序）。
 */
export const LIVE_IMAGES = `${FILE_LIVE('i')} AND +i.root_id IN (${ACTIVE_ROOT_IDS})`;
/** 没被排除（排除结果是可见性模块派生的 excluded_by） */
export const NOT_EXCLUDED = (a = 'i') => `${col(a, 'excluded_by')} IS NULL`;
/**
 * 计入统计（= 视图 v_counted_images）：可见、没被排除。张数、角色张数、队列都只数它。
 * 用法同 VISIBLE（要 JOIN library_roots r）；a 是 images 的别名
 */
export const COUNTED = (a = 'i', r = 'r') => `${FILE_LIVE(a)} AND ${ROOT_ACTIVE(r)} AND ${NOT_EXCLUDED(a)}`;
/** 同 COUNTED，但不用 JOIN library_roots r（写法同 LIVE_IMAGES） */
export const COUNTED_LIVE = `${LIVE_IMAGES} AND ${NOT_EXCLUDED('i')}`;
/** 不计入统计（COUNTED 的反面）：文件夹行不在的图（LEFT JOIN 出 NULL）也算不计入 */
export const NOT_COUNTED = (a = 'i', r = 'r') =>
  `NOT (${col(r, 'id')} IS NOT NULL AND ${ROOT_ACTIVE(r)} AND ${FILE_LIVE(a)} AND ${NOT_EXCLUDED(a)})`;

// ------------------------------------------------------------------ 类型

/** 插画（= 视图 v_illust_images 在计入统计上加的条件）：角色张数、作品张数、图库默认只看它 */
export const ILLUSTRATION = `i.content_kind = 'illustration'`;
/** 要找角色的类型：插画和漫画（T27 补充）。封面候选、「常一起出现」也只看这两类 */
export const ART_KINDS_SQL = `i.content_kind IN (${list(UNRECOGNIZED_ART_KINDS)})`;
/** 未识别「照片 · 文字等」的类型：截图、文字、照片、表情 */
export const ANNEX_KINDS_SQL = `i.content_kind IN (${list(UNRECOGNIZED_ANNEX_KINDS)})`;
/**
 * 是动图（D5：和类型是两个维度，分析模块按帧数、格式写）。字面写 = 1：按入库时间翻页走部分索引 idx_images_animated_live
 * （迁移 038，条件 animated = 1 AND trashed_at IS NULL AND missing = 0），不要改成参数
 */
export const ANIMATED_SQL = 'i.animated = 1';
/** 敏感分级：较敏感、限制级（和前端的模糊判断用同一份 SENSITIVE_RATINGS；模糊范围是显示偏好，不影响这里） */
export const SENSITIVE_SQL = `i.rating IN (${list(SENSITIVE_RATINGS)})`;

// ------------------------------------------------------------------ 角色

/** 有角色关联 */
export const HAS_CHARACTER = (a = 'i') => `EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = ${a}.id)`;
/** 没有角色关联 */
export const NO_CHARACTER = (a = 'i') => `NOT ${HAS_CHARACTER(a)}`;
/** 没认出：没有角色、也没归为原创（原创图不算未识别） */
export const UNRECOGNIZED = `(${NO_CHARACTER('i')} AND i.original_at IS NULL)`;

// ------------------------------------------------------------------ 待处理队列

/** 按漫画导入的范围（整个图库文件夹或里面的子文件夹）：不识别、不找角色，不进队列 */
export const IN_COMIC_I = IN_COMIC('i');
/**
 * 不在整本处理的合集里：本子、画集（active）里的页不逐张进队列（T38c），在「成册待整理」里整本处理。组图的页照常逐张处理
 */
export const NOT_IN_BOOK =
  "NOT EXISTS (SELECT 1 FROM collections bc WHERE bc.id = i.collection_id AND bc.kind <> 'group' AND bc.state = 'active')";
/**
 * 设置「未识别里也列出漫画页」（tagger.comicInUnrecognized，缺省 = 开）。直接在 SQL 里读设置表：
 * 不相关子查询每条语句只算一次，用到队列的地方不用各自传参数
 */
export const COMIC_IN_QUEUE = `COALESCE((SELECT json_extract(s.value, '$.comicInUnrecognized') FROM settings s WHERE s.key = 'tagger'), 1)`;
/** 未识别「插画 · 漫画」要找角色的类型：插画，加上设置开着时的漫画页 */
export const QUEUE_KINDS_SQL = `(i.content_kind = 'illustration' OR (i.content_kind = 'comic' AND ${COMIC_IN_QUEUE}))`;
/**
 * 逐张找角色的图：插画和漫画（不看漫画设置），不在整本处理的合集里、不在漫画区。Pixiv 资格、补采纳的范围用它：
 * 漫画页关掉「未识别里也列出漫画页」只是不列出来，识别、自动关联、Pixiv 照常（附录 #1）
 */
export const ART_SCOPE = `${ART_KINDS_SQL} AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC_I}`;
/**
 * 「插画 · 漫画」队列的范围（含放下的、含已经认出的）：插画和设置开着时的漫画，不在整本处理的合集里、不在漫画区。
 * 「已认出比例」的分母就是它（汇总接口 recognition.scope）
 */
export const ART_QUEUE_SCOPE = `${QUEUE_KINDS_SQL} AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC_I}`;
/**
 * 不逐张找角色的图：在整本处理的合集里（NOT NOT_IN_BOOK），或者在漫画区（IN_COMIC）。和那两个片段是同一个口径，
 * 只是写成按合集、漫画区的索引去找的 id 集合（统计用它从类型张数里减出「插画 · 漫画」队列的范围，不用对每一行判断；
 * 等价性见 readmodel/terms.test.ts）。漫画子文件夹按 (root_id, rel_path) 唯一索引取范围：'/' 的下一个字符是 '0'
 */
export const BOOK_OR_COMIC_IDS = `SELECT bi.id FROM images bi
      WHERE bi.collection_id IN (SELECT id FROM collections WHERE kind <> 'group' AND state = 'active')
    UNION ${COMIC_AREA_IMAGE_IDS}`;

/**
 * 「插画 · 漫画」队列（逐张的未识别队列）：队列范围里没有放下、没认出的。统计、分段、侧栏、汇总共用这一份（MG-9）。
 * i 是 v_counted_images 的别名（或者调用方自己加了 COUNTED）
 */
export const QUEUE = `${QUEUE_KINDS_SQL} AND i.shelved_at IS NULL AND ${UNRECOGNIZED} AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC_I}`;
/** 「放下的」：队列范围里放下了、没认出的（T34a，RV-T-4）。不在「插画 · 漫画」队列里，也不算认出 */
export const SHELVED_QUEUE = `${QUEUE_KINDS_SQL} AND i.shelved_at IS NOT NULL AND ${UNRECOGNIZED} AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC_I}`;
/** 「照片 · 文字等」队列：截图、文字、照片、表情里没认出的（别册不催：不计入待处理数） */
export const ANNEX_QUEUE = `${ANNEX_KINDS_SQL} AND ${UNRECOGNIZED}`;
/** 「待识别」：「插画 · 漫画」队列里还没跑过识别的；漫画不算（它不等识别，直接算没认出，RV-T-1 ③） */
export const UNTAGGED_UNRECOGNIZED = `i.tagged_at IS NULL AND i.content_kind <> 'comic' AND ${QUEUE}`;
/**
 * 识别任务会看的图（计入统计之外的条件）：不在漫画区；设置跳过相机照片时（@skipCamera = 1）不看带相机信息的照片。
 * 写成 CASE：camera 不在统计的覆盖索引里，只在照片这一支才回表读
 */
export const TAGGABLE = `NOT ${IN_COMIC_I}
  AND (CASE WHEN @skipCamera = 1 AND i.content_kind = 'photo' THEN COALESCE(i.camera, '') = '' ELSE 1 END)`;
/** 还没识别：计入统计、识别任务会看、还没有识别结果（文件换过的也算，P4a）。首页识别进度、导入面板用它 */
export const TAG_PENDING = `i.tagged_at IS NULL AND ${TAGGABLE}`;

/**
 * 一张图在哪个待处理队列（图片接口的 queue 事实，P5，附录 #27）。和 packages/shared 的 triageQueue 是同一条规则：
 * 不计入统计 → 不在；有角色或原创 → 不在；截图等 → annex；在整本处理的合集里 → book；漫画区 → 不在；
 * 关掉漫画设置时的漫画 → 不在；放下的 → shelved；其余 → art。i 是 images（不用 JOIN）
 */
export const QUEUE_OF = `CASE
    WHEN NOT (${COUNTED_LIVE}) THEN NULL
    WHEN NOT ${UNRECOGNIZED} THEN NULL
    WHEN ${ANNEX_KINDS_SQL} THEN 'annex'
    WHEN NOT ${NOT_IN_BOOK} THEN 'book'
    WHEN ${IN_COMIC_I} THEN NULL
    WHEN NOT ${QUEUE_KINDS_SQL} THEN NULL
    WHEN i.shelved_at IS NOT NULL THEN 'shelved'
    ELSE 'art' END`;

// ------------------------------------------------------------------ 图的作品

/** 图片 i 属于作品 @workId —— 和作品张数用同一个视图 v_image_works，数字才对得上 */
export const IMAGE_IN_WORK = 'EXISTS (SELECT 1 FROM v_image_works vw WHERE vw.image_id = i.id AND vw.work_id = @workId)';
/**
 * 图的作品（= 视图 v_image_works）的三支，直接连底表：大查询里连视图，SQLite 会把整个 UNION 视图物化或对每一行重扫一遍
 * （合集统计在真实库副本上要 11 秒、侧栏作品数约 200 ms）。三支是：关联角色的作品、手动指定的作品（原创图不算别的作品，迁移 030）、
 * 原创图 →「原创」作品。模型给的作品是证据，不算（附录 #8）。
 *
 * imageWorkRows(source, where)：source 是图片来源（表或视图，别名 i），返回 (i.id, 作品 id AS work_id, 以及 extra 里的列) 的 UNION
 */
export function imageWorkRows(source: string, where: string, extra = ''): string {
  const x = extra ? `, ${extra}` : '';
  return `SELECT i.id AS image_id, cw.work_id AS work_id${x} FROM ${source}
      JOIN image_characters ic ON ic.image_id = i.id JOIN character_works cw ON cw.character_id = ic.character_id WHERE ${where}
    UNION
    SELECT i.id, ico.work_id${x} FROM ${source} JOIN image_copyrights ico ON ico.image_id = i.id WHERE ${where} AND i.original_at IS NULL
    UNION
    SELECT i.id, ow.id${x} FROM ${source} JOIN works ow ON ow.danbooru_tag = 'original' WHERE ${where} AND i.original_at IS NOT NULL`;
}
/**
 * 作品 w 有计入统计的插画（作品列表只列这样的作品，侧栏的作品数同口径，附录 #26）。三支 EXISTS 各走索引，
 * 和 v_image_works ⋈ v_illust_images 完全等价（readmodel/terms.test.ts 比对）
 */
export const WORK_HAS_ILLUSTRATION = `(EXISTS (SELECT 1 FROM image_copyrights x JOIN v_illust_images i ON i.id = x.image_id
               WHERE x.work_id = w.id AND i.original_at IS NULL)
    OR EXISTS (SELECT 1 FROM character_works cw JOIN image_characters ic ON ic.character_id = cw.character_id
               JOIN v_illust_images i ON i.id = ic.image_id WHERE cw.work_id = w.id)
    OR (w.danbooru_tag = 'original' AND EXISTS (SELECT 1 FROM v_illust_images i WHERE i.original_at IS NOT NULL)))`;

// ------------------------------------------------------------------ 排名用的「一张」

/**
 * 排名、排序用的张数按什么数（内部点 term:count.unit，第 3 层插件能改，docs/plugins.md 第 7 节）：返回一张图的「计数键」的 SQL，
 * 键相同的算一张。内置是每张图各算一张（图片 id）；比如「一个作品算一张」的插件把同一个 Pixiv 投稿的组图算成一张。
 * 用它的：角色的张数、最近 30 天、+N（Derived 的角色统计），作品的张数（Derived 的作品统计），画师的张数（listArtists）——
 * 角色、作品、画师列表按张数排、首页「收得最多」「你最常看的」都是这几个数。图库的总数、近 7 天的柱状图不用它。
 * a 是 images（或视图）的别名。用法：COUNT(DISTINCT 计数键)，计数键 = ctx.points.wrap(COUNT_UNIT_POINT, COUNT_UNIT)('i')
 */
export const COUNT_UNIT = (a = 'i'): string => `${a}.id`;
export const COUNT_UNIT_POINT = 'term:count.unit';

/** 口径里登记成内部点的（引擎开的时候登记，core/points.ts）。改了它们的用法（拼进 SQL 的方式）就把 version 加一 */
export const TERM_POINTS = [{ name: COUNT_UNIT_POINT, label: '排名的张数怎么数', version: 1, base: COUNT_UNIT }] as const;

// ------------------------------------------------------------------ 其他展示口径

/** 「没认出」的画面主题：存的 theme 加上查询时判定的漫画、不像插画、敏感（与 services/classify/theme.ts 的 resolveTheme 一致） */
export const THEME_EXPR = `CASE WHEN i.content_kind = 'comic' THEN 'comic' WHEN i.theme = 'odd' THEN 'odd'
    WHEN ${SENSITIVE_SQL} THEN 'nsfw' ELSE COALESCE(i.theme, 'other') END`;
