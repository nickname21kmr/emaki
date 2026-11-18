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

/**
 * 随机 UUID v4。不直接用 crypto.randomUUID：它只在安全上下文（https 或 localhost）里有，
 * 手机用局域网 http 地址打开页面时是 undefined，所有写操作的 Idempotency-Key 都会抛错。
 * crypto.getRandomValues 在任何上下文都可用。
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
