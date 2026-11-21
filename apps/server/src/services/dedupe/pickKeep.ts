/**
 * 推荐保留哪一张：在合集里 → 像素数 → 体积 → 文件名不像副本 → 和同一投稿的其他页在一起 → 入库早 → id 小。
 * 合集（画集、本子）里的页是整本书的一部分，同一张图另一份在下载、QQ 文件夹里时留书里那份（用户 2026-10-04）。
 * 和同一投稿的其他页在一起（用户 2026-11-20）：一个 Pixiv 投稿手机上下了 5 张、先同步上来，电脑上又批量下了 10 张，
 * 两份完全一样时留电脑下载文件夹里那份（那里有完整的 10 张），投稿不会被拆在两个文件夹里。
 */
export interface KeepCandidate {
  id: number;
  width: number;
  height: number;
  bytes: number;
  file_name: string;
  added_at: string;
  /** 所在合集；不知道时不传 */
  collection_id?: number | null;
  /** 同一个文件夹里同一投稿（站点 + 投稿号）的其他图有几张；不知道时不传 */
  post_siblings?: number;
}

const COPY = /(\s*\(\d+\)|\s*-\s*(副本|复制|copy)(\s*\(\d+\))?)$/i;
const looksLikeCopy = (name: string) => COPY.test(name.replace(/\.[^.]+$/, ''));

export function pickKeep<T extends KeepCandidate>(members: T[]): T {
  return [...members].sort(
    (a, b) =>
      Number(b.collection_id != null) - Number(a.collection_id != null) ||
      b.width * b.height - a.width * a.height ||
      b.bytes - a.bytes ||
      Number(looksLikeCopy(a.file_name)) - Number(looksLikeCopy(b.file_name)) ||
      (b.post_siblings ?? 0) - (a.post_siblings ?? 0) ||
      a.added_at.localeCompare(b.added_at) ||
      a.id - b.id,
  )[0]!;
}
