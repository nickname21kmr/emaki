import { performance } from 'node:perf_hooks';

/**
 * 本地日期（年月日拼成一个数）。「本周新收」「最近 30 天」这类按天算的数过了零点要重算，
 * 缓存拿它当 epoch：日期变了，之前算的就不再用
 */
export function localDay(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * 两级失效的结果缓存（T22）。
 * - 硬失效（用户操作）：下一次读一定重算。
 * - 软失效（后台扫描 / 识别写库）：旧结果最多再用 softMs 毫秒，过了才重算。
 *
 * 识别期间每 3 秒一次 changed 事件（后台任务的事件节流，propagation/engine.ts），前端会把已加载的 query 全部重拉；better-sqlite3 是同步的，
 * 没有这层的话统计、总数这些几十到几百毫秒的查询会一遍遍卡住整个服务（包括缩略图和 SSE）。
 * 软窗口用真实时间（performance.now），不用 ctx.clock：测试里的假时钟是定值。
 */
export class SoftCache<T> {
  private readonly map = new Map<string, { value: T; hard: number; soft: number; at: number; epoch: unknown }>();
  private hardGen = 0;
  private softGen = 0;

  /**
   * softMs：软失效后旧结果还能用多久；maxMs：不管有没有失效，最长用多久（兜底）；
   * epoch：算出来的结果只在它不变的期间有效（传本地日期：「最近 7 天」这类随日期变的数过了零点就重算）
   */
  constructor(private readonly opts: { softMs: number; maxMs?: number; max?: number; epoch?: () => unknown }) {}

  invalidate(soft = false): void {
    if (soft) this.softGen++;
    else {
      this.hardGen++;
      this.map.clear();
    }
  }

  /** 只让 stale 认领的键失效（硬失效删掉；软失效标成过期，旧结果照样再用 softMs），别的键不动 */
  invalidateWhere(stale: (key: string) => boolean, soft = false): void {
    for (const [key, e] of this.map) {
      if (!stale(key)) continue;
      if (soft) e.soft = -1;
      else this.map.delete(key);
    }
  }

  get(key: string, compute: () => T): T {
    const e = this.map.get(key);
    const now = performance.now();
    const epoch = this.opts.epoch?.();
    const fresh = e && e.hard === this.hardGen && e.epoch === epoch && (e.soft === this.softGen || now - e.at < this.opts.softMs);
    if (e && fresh && now - e.at < (this.opts.maxMs ?? Infinity)) {
      // LRU：命中的挪到最后
      this.map.delete(key);
      this.map.set(key, e);
      return e.value;
    }
    const value = compute();
    this.map.delete(key);
    this.map.set(key, { value, hard: this.hardGen, soft: this.softGen, at: performance.now(), epoch });
    const max = this.opts.max ?? 100;
    while (this.map.size > max) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}
