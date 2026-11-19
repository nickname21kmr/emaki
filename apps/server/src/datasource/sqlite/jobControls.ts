/** 后台任务的手动启动和取消（T07）：任务本身怎么跑见 services/pipeline.ts 和 open.ts 里的组装 */
import type { ID, Job, JobKind, StartJobBody } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import type { Pipeline } from '../../services/pipeline.ts';
import { clearPendingPixivCache, queuePixivImages, resetPixivBackoff } from '../../services/pixiv/sync.ts';
import type { ScanRequests } from '../../services/scan/ScanRequests.ts';
import { resetIoBackoff } from '../../services/tagger/readBackoff.ts';
import type { SqliteContext } from './context.ts';

export class JobControls {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly requests: ScanRequests,
    private readonly pipeline: Pipeline,
  ) {}

  list(): Job[] {
    return this.ctx.jobs.list();
  }

  start(kind: JobKind, options: Pick<StartJobBody, 'refreshPixiv'> = {}): Job {
    if (options.refreshPixiv && kind !== 'pixiv-tags') throw new BadRequestError('刷新 Pixiv 标签只用于补充 Pixiv 角色');
    if (kind === 'pixiv-tags') {
      // Repeated starts must not reset checks or invalidate cache during an active run.
      const active = this.ctx.jobs.list().find(j => j.kind === kind && (j.status === 'running' || j.status === 'queued'));
      if (active) return active;
      queuePixivImages(this.ctx);
      if (options.refreshPixiv) clearPendingPixivCache(this.ctx);
      resetPixivBackoff();
    }
    if (kind === 'scan') this.requests.requestFull();
    // 用户手动点的：之前读不到、正在退避的图也马上重试（比如刚把移动硬盘插回去）
    if (kind === 'tag' || kind === 'artists') resetIoBackoff();
    this.pipeline.noteManualStart(kind);
    // 手动扫描时正在跑监听触发的增量扫描：它开始时已经取走了请求，不再排一次的话这次全量扫描就被吞了
    return this.ctx.jobs.enqueue(kind, { requeueIfRunning: kind === 'scan' });
  }

  cancel(id: ID): void {
    // 排队中的任务被取消时 runner 不会执行，pipeline 收不到「被取消」：这里先记下暂停，免得识别一结束又排上
    const job = this.ctx.jobs.list().find((j) => j.id === id);
    if (job && (job.status === 'queued' || job.status === 'running')) this.pipeline.notePaused(job.kind);
    this.ctx.jobs.cancel(id);
    // 识别完追加排上的那一轮 Pixiv 也一起取消，不然取消后马上又开始请求 pixiv.net
    if (job?.kind === 'pixiv-tags') for (const j of this.ctx.jobs.list()) if (j.kind === 'pixiv-tags' && j.status === 'queued') this.ctx.jobs.cancel(j.id);
  }
}
