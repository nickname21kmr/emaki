import { performance } from 'node:perf_hooks';

/**
 * 两级失效的结果缓存（T22）。
 * - 硬失效（用户操作）：下一次读一定重算。
 * - 软失效（后台扫描 / 识别写库）：旧结果最多再用 softMs 毫秒，过了才重算。
 *
 * 识别期间每 5 秒一次 library-changed，前端会把已加载的 query 全部重拉；better-sqlite3 是同步的，
 * 没有这层的话统计、总数这些几十到几百毫秒的查询会一遍遍卡住整个服务（包括缩略图和 SSE）。
 * 软窗口用真实时间（performance.now），不用 ctx.clock：测试里的假时钟是定值。
 */
export class SoftCache<T> {
  private readonly map = new Map<string, { value: T; hard: number; soft: number; at: number }>();
  private hardGen = 0;
  private softGen = 0;

  /** softMs：软失效后旧结果还能用多久；maxMs：不管有没有失效，最长用多久（「最近 7 天」这类随时间变的数） */
  constructor(private readonly opts: { softMs: number; maxMs?: number; max?: number }) {}

  invalidate(soft = false): void {
    if (soft) this.softGen++;
    else {
      this.hardGen++;
      this.map.clear();
    }
  }

  get(key: string, compute: () => T): T {
    const e = this.map.get(key);
    const now = performance.now();
    const fresh = e && e.hard === this.hardGen && (e.soft === this.softGen || now - e.at < this.opts.softMs);
    if (e && fresh && now - e.at < (this.opts.maxMs ?? Infinity)) {
      // LRU：命中的挪到最后
      this.map.delete(key);
      this.map.set(key, e);
      return e.value;
    }
    const value = compute();
    this.map.delete(key);
    this.map.set(key, { value, hard: this.hardGen, soft: this.softGen, at: performance.now() });
    const max = this.opts.max ?? 100;
    while (this.map.size > max) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}
