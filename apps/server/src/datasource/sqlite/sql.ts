/** SQLite 数据源共用的小工具。其他任务只 import，不要再写一份。 */
import type { ImageFormat, Page } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';

export const toId = (n: number | bigint): string => String(n);

/** API 字符串 id → 整数；不合法返回 null（调用方按「找不到」处理，不要 500） */
export function parseId(id: string | null | undefined): number | null {
  return id && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
}

export const bool = (v: boolean): 0 | 1 => (v ? 1 : 0);
export const iso = (ms: number): string => new Date(ms).toISOString();

/** 数组参数一律：WHERE id IN (SELECT value FROM json_each(?))，绕开参数个数上限 */
export const jsonArray = (xs: readonly (number | string)[]): string => JSON.stringify(xs);

export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor<T>(s: string | undefined, isValid: (x: unknown) => x is T): T | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (isValid(v)) return v;
  } catch {
    /* 走到下面 */
  }
  throw new BadRequestError('分页游标无效，请刷新页面');
}

/** 与 mock 相同的偏移分页，只用于已在内存里排好序的小列表（角色） */
export function paginateOffset<T>(all: T[], cursor: string | undefined, limit: number | undefined): Page<T> {
  const start = cursor ? Number(cursor) || 0 : 0;
  const size = Math.min(Math.max(limit ?? 60, 1), 200);
  const items = all.slice(start, start + size);
  const next = start + size;
  return { items, nextCursor: next < all.length ? String(next) : null, total: all.length };
}

export const DAY = 86_400_000;
export const RECENT_DAYS = 30;

/**
 * 用法：FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${VISIBLE}
 * 条件必须字面上包含 i.missing = 0 AND i.trashed_at IS NULL（T22 的部分索引靠它命中）
 */
export const VISIBLE = 'i.missing = 0 AND i.trashed_at IS NULL AND r.enabled = 1 AND r.removed_at IS NULL';
/**
 * 同 VISIBLE，但不用 JOIN library_roots r（T22）：图片列表只查 images 一张表，查询计划才会沿排序索引走、找够一页就停。
 * `+i.root_id` 的加号是故意的：不让 SQLite 拿 root_id 上的索引去驱动查询（那样要先把整个文件夹的图排一遍序）。
 * 部分索引要求字面包含 `trashed_at IS NULL AND missing = 0`，不要改写这两个条件。
 */
export const LIVE_IMAGES =
  'i.missing = 0 AND i.trashed_at IS NULL AND +i.root_id IN (SELECT id FROM library_roots WHERE enabled = 1 AND removed_at IS NULL)';
/** 图片 i 属于作品 @workId —— 与 T13 的作品张数用同一个视图，数字才对得上 */
export const IMAGE_IN_WORK = 'EXISTS (SELECT 1 FROM v_image_works vw WHERE vw.image_id = i.id AND vw.work_id = @workId)';
export const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
/** 像素处理还没跑时的占位色 */
export const DEFAULT_DOMINANT = '#d9d4cc';

/** 未识别（没有任何角色关联）。i 是 v_counted_images 的别名 */
export const UNRECOGNIZED = '(NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id) AND i.original_at IS NULL)';
/** 插画和漫画：要找角色的图（T27 补充） */
export const ART_KINDS_SQL = `i.content_kind IN ('illustration','comic')`;
/** 别册：既不是插画也不是漫画 */
export const ANNEX_KINDS_SQL = `i.content_kind IN ('screenshot','text','photo','meme','animated')`;
/** 按漫画导入的图库文件夹（不识别、不找角色） */
export const COMIC_ROOT_IDS = "(SELECT id FROM library_roots WHERE content_mode = 'comic')";
/**
 * 逐张「未识别」队列：插画和漫画、没有放下、没有角色。getStats、分段、侧栏共用这一份（MG-9）。
 * 合集里的页不逐张进队列（T38c），在「成册待整理」里整本处理；按漫画导入的文件夹不找角色，不进队列。
 */
export const QUEUE = `${ART_KINDS_SQL} AND i.shelved_at IS NULL AND ${UNRECOGNIZED} AND i.collection_id IS NULL AND i.root_id NOT IN ${COMIC_ROOT_IDS}`;
/** 「待识别」：队列里还没跑过识别的；漫画不算（它按本处理，RV-T-1 ③） */
export const UNTAGGED_UNRECOGNIZED = `i.tagged_at IS NULL AND i.content_kind <> 'comic' AND ${QUEUE}`;
/** 图片所在目录（带末尾的 /） */
export const DIR_EXPR = 'substr(i.rel_path, 1, length(i.rel_path) - length(i.file_name))';
/** 「没认出」的画面主题：存的 theme 加上查询时判定的漫画、不像插画、敏感（与 services/classify/theme.ts 的 resolveTheme 一致） */
export const THEME_EXPR = `CASE WHEN i.content_kind = 'comic' THEN 'comic' WHEN i.theme = 'odd' THEN 'odd' WHEN i.rating IN ('questionable','explicit') THEN 'nsfw' ELSE COALESCE(i.theme, 'other') END`;
