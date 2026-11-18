/**
 * SQLite 数据源共用的小工具。其他任务只 import，不要再写一份。
 * 口径（可见、计入统计、队列……）不在这里，在 readmodel/terms.ts（P5）。
 */
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

/** 偏移分页，只用于已在内存里排好序的小列表（角色） */
export function paginateOffset<T>(all: T[], cursor: string | undefined, limit: number | undefined): Page<T> {
  const start = cursor ? Number(cursor) || 0 : 0;
  const size = Math.min(Math.max(limit ?? 60, 1), 200);
  const items = all.slice(start, start + size);
  const next = start + size;
  return { items, nextCursor: next < all.length ? String(next) : null, total: all.length };
}

export const DAY = 86_400_000;
export const RECENT_DAYS = 30;

export const MIME: Record<ImageFormat, string> = {
  html: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
/** 像素处理还没跑时的占位色 */
export const DEFAULT_DOMINANT = '#d9d4cc';
