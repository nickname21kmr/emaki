/**
 * 查重基准：10 万条 64 位哈希（70% 随机 + 30% 近似重复），阈值 8。
 *   npx tsx apps/server/scripts/bench-dedupe.ts [N] [T]
 */
import { buildGroups, type DedupeRow } from '../src/services/dedupe/DedupeService.ts';

const N = Number(process.argv[2] ?? 100_000);
const T = Number(process.argv[3] ?? 8);
let seed = 1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
};
const hex = (hi: number, lo: number) => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
const rows: DedupeRow[] = [];
let prev: [number, number] = [rnd(), rnd()];
for (let i = 0; i < N; i++) {
  let h: [number, number];
  if (i > 0 && rnd() % 10 < 3) {
    h = [...prev];
    for (let f = rnd() % 10; f > 0; f--) {
      const bit = rnd() % 64;
      if (bit < 32) h[0] = (h[0] ^ (1 << bit)) >>> 0;
      else h[1] = (h[1] ^ (1 << (bit - 32))) >>> 0;
    }
  } else h = [rnd(), rnd()];
  prev = h;
  rows.push({ id: i + 1, sha256: `s${i}`, dhash: hex(...h), width: 1000, height: 800, bytes: 1000, file_name: `${i}.png`, added_at: '2026-01-01T00:00:00.000Z' });
}
const t0 = performance.now();
const r = buildGroups(rows, T);
const sec = (performance.now() - t0) / 1000;
console.log(`N=${N} T=${T}：${r.groups.length} 组，丢弃过大簇 ${r.droppedLarge}，耗时 ${sec.toFixed(2)} 秒`);
