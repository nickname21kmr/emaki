/**
 * 把一个字符串变成稳定的随机种子（SEL-9 今日一枚）：FNV-1a 32 位 + murmur fmix32 终混，取 30 位。
 * 同一个 key 永远得到同一个数；相邻的 key（`20260928:0`、`20260928:1`）得到的数看不出规律。
 */
export function daySeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) & 0x3fffffff;
}

/** 本地日期的 yyyyMMdd */
export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
