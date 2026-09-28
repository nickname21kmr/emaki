/**
 * 推荐保留哪一张：像素数 → 体积 → 文件名不像副本 → 入库早 → id 小。
 */
export interface KeepCandidate {
  id: number;
  width: number;
  height: number;
  bytes: number;
  file_name: string;
  added_at: string;
}

const COPY = /(\s\(\d+\)|\s*-\s*(副本|复制|copy)(\s*\(\d+\))?)$/i;
const looksLikeCopy = (name: string) => COPY.test(name.replace(/\.[^.]+$/, ''));

export function pickKeep<T extends KeepCandidate>(members: T[]): T {
  return [...members].sort(
    (a, b) =>
      b.width * b.height - a.width * a.height ||
      b.bytes - a.bytes ||
      Number(looksLikeCopy(a.file_name)) - Number(looksLikeCopy(b.file_name)) ||
      a.added_at.localeCompare(b.added_at) ||
      a.id - b.id,
  )[0]!;
}
