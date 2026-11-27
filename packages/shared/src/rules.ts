/**
 * 前后端共用的展示规则（docs/core-architecture.md 第 6 节，P5，附录 #27、#30、#38）。
 *
 * 每条规则只写一份：类型、分级、任务、合集类型的名称和说明；「能否不打码显示」；「在哪个待处理队列」；「话 / 册」；
 * 无题时的显示名；排除规则目标的归一化；剩余时间的写法。服务端（提示文案、SQL 口径的 JS 版本）和网页都从这里取，
 * 不要在别处再写一份。
 */
import type { CollectionKind, ContentKind, JobKind, Rating } from './domain.ts';
import { JOB_KIND_LIST, JOB_KINDS } from './jobs.ts';

// ------------------------------------------------------------------ 名称和说明

/** 类型名（T27）：插画是主角，其余五类统称「别册」 */
export const KIND_LABEL: Record<ContentKind, string> = {
  illustration: '插画',
  comic: '漫画',
  screenshot: '截图',
  text: '文字',
  photo: '照片',
  meme: '表情',
};

/** 朱文小印上的字（T32b） */
export const KIND_GLYPH: Record<ContentKind, string> = {
  illustration: '插',
  comic: '漫',
  screenshot: '截',
  text: '文',
  photo: '照',
  meme: '表',
};

/** 每类是什么（改类型的菜单、别册目次、未识别「照片 · 文字等」都用这一份） */
export const KIND_HINT: Record<ContentKind, string> = {
  illustration: '单幅插画、CG、立绘、封面',
  comic: '漫画和本子的内页、分镜、四格',
  screenshot: '手机电脑截屏、聊天记录、视频截图',
  text: '文档、笔记、满屏文字、二维码',
  photo: '相机拍的照片、真人、实物',
  meme: '表情包、梗图、反应图',
};

/** 分级名（Danbooru 的四档） */
export const RATING_LABEL: Record<Rating, string> = {
  general: '全年龄',
  sensitive: '轻微',
  questionable: '较敏感',
  explicit: '限制级',
};

/** 后台任务名（设置页的任务列表、首页横幅、命令面板、服务端的任务消息）：取自任务种类的注册表（jobs.ts） */
export const JOB_LABEL = Object.fromEntries(JOB_KIND_LIST.map((k) => [k, JOB_KINDS[k].label])) as Record<JobKind, string>;
/** 一个任务显示的名字：插件的任务用插件登记的名字，其余按种类 */
export const jobTitle = (job: { kind: JobKind; title?: string }): string => job.title ?? JOB_LABEL[job.kind];

/** 合集类型（T38）：名称、量词、书名印上的字、一句说明 */
export const COLLECTION_KIND_META: Record<CollectionKind, { label: string; unit: string; glyph: string; hint: string }> = {
  group: { label: '组图', unit: '组', glyph: '组', hint: '收在一起的散图，逐张照常识别' },
  doujin: { label: '本子', unit: '本', glyph: '本', hint: '按页码顺序读' },
  artbook: { label: '画集', unit: '册', glyph: '画', hint: '里面的插画照常计入角色' },
};

// ------------------------------------------------------------------ 分级和模糊（附录 #30）

/** 敏感分级：较敏感、限制级。服务端「没认出」的「敏感」主题也按这一份（不看模糊范围：分组不该随显示偏好变） */
export const SENSITIVE_RATINGS: readonly Rating[] = ['questionable', 'explicit'];
export const isSensitive = (rating: Rating) => SENSITIVE_RATINGS.includes(rating);

/** 模糊范围：较敏感和限制级 / 仅限制级 */
export type BlurLevel = 'questionable' | 'explicit';
/** 为什么要打码：分级、照片、文字，或者分级还不可信（unrated） */
export type BlurReason = 'rating' | 'photo' | 'text' | 'unrated';

/** 模糊判断用的本机偏好（都是这台设备的偏好，见第 6 节「设置的归属」） */
export interface BlurPrefs {
  blurSensitive: boolean;
  blurLevel: BlurLevel;
  blurPhoto: boolean;
  blurText: boolean;
}

export interface BlurSubject {
  rating: Rating;
  /** 封面类（角色封面、头像、扇形、书的封面）不传类型，只按分级 */
  kind?: ContentKind | null;
  /** 分级可信：识别过（或手动定过）。不传当作可信 */
  rated?: boolean;
}

/**
 * 展示的场合。同一套判断，按场合决定「分级还不可信」和「轻微」怎么处理：
 * - browse：普通浏览（网格、看图器、角色封面、画集和组图的页）。还没识别的图分级默认是全年龄，照常按分级处理——
 *   不然刚导入的图满屏都是糊的。
 * - cautious：分级还不可信（rated = false）就打码。本子的封面和页（本子大多敏感，没识别过的分级多半不对，见 bookBlurContext），
 *   看图器胶片条里还没拿到分级的图。
 * - showcase：无人值守的大幅展示（今日一枚、放映、书封面下面露出的底页）。开着模糊时只放分级可信的全年龄图：
 *   没人在旁边按「显示」，宁可少放也不能放错；「轻微」也不放。
 */
export type BlurContext = 'browse' | 'cautious' | 'showcase';

/** 合集里的封面和页按哪个场合：本子 cautious（本子大多敏感，RV-C-12），画集、组图 browse */
export const bookBlurContext = (kind: CollectionKind): BlurContext => (kind === 'doujin' ? 'cautious' : 'browse');

/**
 * 能否不打码显示：返回打码的原因，null = 可以直接显示（唯一的一套判断，附录 #30）。
 * 总开关关着一律不打码；优先级：分级不可信（book / showcase）> 分级 > 照片 > 文字。
 */
export function blurReason(s: BlurSubject, p: BlurPrefs, context: BlurContext = 'browse'): BlurReason | null {
  if (!p.blurSensitive) return null;
  if (context !== 'browse' && s.rated === false) return 'unrated';
  // showcase 只放全年龄；别的场合按模糊范围
  const tooSensitive =
    context === 'showcase' ? s.rating !== 'general' : p.blurLevel === 'explicit' ? s.rating === 'explicit' : isSensitive(s.rating);
  if (tooSensitive) return 'rating';
  if (s.kind === 'photo' && p.blurPhoto) return 'photo';
  if (s.kind === 'text' && p.blurText) return 'text';
  return null;
}

export const shouldBlur = (s: BlurSubject, p: BlurPrefs, context: BlurContext = 'browse') => blurReason(s, p, context) !== null;

/** 打码时角标上的字 */
export const blurLabel = (r: BlurReason, rating: Rating) =>
  r === 'photo' ? '照片' : r === 'text' ? '文字' : r === 'unrated' ? '未识别' : RATING_LABEL[rating];

/**
 * showcase 场合在服务端挑图时的条件（今日一枚、放映按查询拉图，和 blurReason 的 showcase 分支是同一条规则）：
 * 开着模糊时只要分级可信的全年龄图
 */
export const showcaseQuery = (blurSensitive: boolean): { rating?: Rating[]; rated?: boolean } =>
  blurSensitive ? { rating: ['general'], rated: true } : {};

// ------------------------------------------------------------------ 待处理队列（附录 #27）

/**
 * 一张图在哪个待处理队列（图片接口的 queue 事实，服务端按同一条规则用 SQL 算好，readmodel/terms.ts 的 QUEUE_OF）：
 * - art：未识别「插画 · 漫画」：插画，加上设置开着时的漫画页，没有角色、没归原创、没放下
 * - shelved：放下的（同上，但用户说了不找了）
 * - annex：未识别「照片 · 文字等」：截图、文字、照片、表情里没有角色的
 * - book：没有角色、但在整本处理的合集（本子、画集）里：这一页不单独进队列，跟着这本书在「成册待整理」里处理
 * null = 不在任何队列：有角色、归为原创、被排除或不可见、在漫画区（按漫画导入的文件夹不找角色）、关掉漫画设置时的漫画页
 */
export type TriageQueue = 'art' | 'shelved' | 'annex' | 'book';

export interface TriageFacts {
  kind: ContentKind;
  /** 计入统计：可见、没被排除 */
  counted: boolean;
  characterCount: number;
  original: boolean;
  shelved: boolean;
  /** 在整本处理的合集（本子、画集）里 */
  inBook: boolean;
  /** 在漫画区（按漫画导入的文件夹） */
  inComicArea: boolean;
  /** 设置「未识别里也列出漫画页」 */
  comicInQueue: boolean;
}

export function triageQueue(f: TriageFacts): TriageQueue | null {
  if (!f.counted || f.characterCount > 0 || f.original) return null;
  if (f.kind !== 'illustration' && f.kind !== 'comic') return 'annex';
  if (f.inBook) return 'book';
  if (f.inComicArea) return null;
  if (f.kind === 'comic' && !f.comicInQueue) return null;
  return f.shelved ? 'shelved' : 'art';
}

/**
 * 改类型之后在哪个队列：未识别页改类型时先把图移出列表、不等服务端重拉。只对现在在 art / shelved / annex 里的图用——
 * 它们已知计入统计、没有角色、没归原创；在 art / shelved 里的还已知不在整本处理的合集、不在漫画区（annex 的不知道，按不在估，重拉后以服务端为准）。
 * 以前未识别页假定「改成漫画一定还在队列里」，关掉漫画设置时就错了（附录 #27）
 */
export function queueAfterKindChange(queue: TriageQueue, kind: ContentKind, comicInQueue: boolean): TriageQueue | null {
  const known = { counted: true, characterCount: 0, original: false, inBook: false, inComicArea: false };
  return triageQueue({ ...known, kind, shelved: queue === 'shelved', comicInQueue });
}

// ------------------------------------------------------------------ 合集的显示

/**
 * 话数：第3话 / 3話 / 第3回 / 第3章 / Chapter 3 / Ch.3 / Ep.3。服务端 parseName 拿它判卷号还是话数，网页拿它决定写「话」还是「册」
 */
const N = String.raw`(\d{1,4}(?:\.\d{1,2})?)`;
export const CHAPTER_MARKS: readonly RegExp[] = [
  new RegExp(String.raw`(?:第\s*)?${N}\s*[话話回章]`),
  new RegExp(String.raw`(?<![a-z])(?:ch(?:apter)?|ep(?:isode)?)[._\s]*${N}`, 'i'),
];

/** 连载（文件夹名带话数）按「话」，其余按「册」 */
export const volumeUnit = (folderName: string): '话' | '册' => (CHAPTER_MARKS.some((re) => re.test(folderName.normalize('NFC'))) ? '话' : '册');

/** 合集的显示名：没有标题（文件夹名是一串哈希）时写「无题 #前 6 位」；连文件夹名都没有（手动的组图）写「无题」 */
export const collectionTitle = (c: { title: string | null; folderName?: string | null }) =>
  c.title ?? (c.folderName ? `无题 #${c.folderName.slice(0, 6)}` : '无题');

/**
 * 组图「整理到子文件夹」时子文件夹的名字：去掉文件名里不能用的字符和开头的点、$、空格，最长 70 个字；没有标题用「组图」。
 * 服务端真的建文件夹用它，网页的确认弹窗用它预览（以前两边各写一份）
 */
export const organizeFolderName = (title: string | null): string =>
  (title ?? '组图')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[.$ ]+/, '')
    .slice(0, 70) || '组图';

// ------------------------------------------------------------------ 排除规则

/** 标签规则的目标：去掉首尾空白、小写、空白换成下划线（Danbooru 标签不含空格） */
export const normalizeExclusionTag = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '_');

// ------------------------------------------------------------------ 时间

/** 剩余时间的写法：「40 秒」「3 分钟」「1.5 小时」；不知道（无穷大、NaN）时 null */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}
