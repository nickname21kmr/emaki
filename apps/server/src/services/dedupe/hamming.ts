/**
 * 64 位 dHash 的近邻搜索：多索引哈希（MIH，Norouzi 等）。64 位切 4 段，两条距离 ≤ T 则至少一段距离 ≤ ⌊T/4⌋（鸽巢原理），
 * 每段建 65536 个桶的倒排表，查询时枚举 popcount ≤ ⌊T/4⌋ 的掩码。结果精确，不漏（测试对照暴力枚举）。
 */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export const parseDHash = (hex: string): [number, number] => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];

/** 对 hi/lo 数组里所有距离 ≤ T 的对（a < b）调用 onPair。T 必须在 0..16 */
export function findSimilarPairs(hi: Uint32Array, lo: Uint32Array, T: number, onPair: (a: number, b: number, d: number) => void): void {
  const N = hi.length;
  const R = Math.floor(T / 4);
  const chunk = (i: number, k: number) => (k === 0 ? hi[i]! & 0xffff : k === 1 ? hi[i]! >>> 16 : k === 2 ? lo[i]! & 0xffff : lo[i]! >>> 16);
  const masks: number[] = [];
  for (let m = 0; m < 65536; m++) if (popcount32(m) <= R) masks.push(m);
  // CSR 倒排表：cnt 是前缀和，ids 按桶排列
  const tables = [0, 1, 2, 3].map((k) => {
    const cnt = new Uint32Array(65537);
    for (let i = 0; i < N; i++) cnt[chunk(i, k) + 1]!++;
    for (let v = 0; v < 65536; v++) cnt[v + 1]! += cnt[v]!;
    const pos = cnt.slice();
    const ids = new Uint32Array(N);
    for (let i = 0; i < N; i++) ids[pos[chunk(i, k)]!++] = i;
    return { cnt, ids };
  });
  const seen = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) {
    for (let k = 0; k < 4; k++) {
      const c = chunk(q, k);
      const { cnt, ids } = tables[k]!;
      for (const m of masks) {
        const v = c ^ m;
        for (let p = cnt[v]!; p < cnt[v + 1]!; p++) {
          const j = ids[p]!;
          if (j <= q || seen[j] === q) continue;
          seen[j] = q;
          const d = popcount32((hi[q]! ^ hi[j]!) >>> 0) + popcount32((lo[q]! ^ lo[j]!) >>> 0);
          if (d <= T) onPair(q, j, d);
        }
      }
    }
  }
}
