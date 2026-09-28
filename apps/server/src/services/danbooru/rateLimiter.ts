import { setTimeout as sleep } from 'node:timers/promises';

/** 串行限速：相邻两次请求的开始时间 ≥ minIntervalMs（Danbooru 建议持续使用约 1 req/s） */
export class RateLimiter {
  private nextAt = 0;

  constructor(
    private readonly minIntervalMs = 1000,
    // 单调时钟：不受系统改时间影响，也和 setTimeout 的计时一致（Date.now 与之混用会有几毫秒误差）
    private readonly now = () => performance.now(),
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const at = Math.max(this.now(), this.nextAt);
    this.nextAt = at + this.minIntervalMs;
    // Node 的定时器按整毫秒截断、用事件循环缓存的时间，可能提前 1–2ms 醒来：向上取整，醒来后再核对一次
    for (let left = at - this.now(); left > 0; left = at - this.now()) await sleep(Math.ceil(left), undefined, { signal });
    // 下一次从「真正放行的时刻」算起：机器忙、放行晚了几毫秒时，间隔也不会被压缩
    this.nextAt = Math.max(this.nextAt, this.now() + this.minIntervalMs);
  }
}
