/**
 * 不起 HTTP，直接对开发库扫描一个文件夹。
 *   $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t03'; npx tsx apps/server/scripts/scan-once.ts <rootPath>
 *
 * 扫描器只看、只读，写库和后续处理（类型、来源、排除、合集……）经变更传播完成（P4a），所以用真实引擎打开库（后台任务关着）。
 */
import { config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import type { JobContext } from '../src/core/jobs.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';
import { normalizeRootPath } from '../src/datasource/sqlite/settings.ts';
import { formatScanSummary } from '../src/services/scan/Scanner.ts';

const rootArg = process.argv[2];
if (!rootArg) {
  console.error('用法：npx tsx apps/server/scripts/scan-once.ts <rootPath>');
  process.exit(1);
}
const ds = await SqliteDataSource.open(new EventBus(), config.dataDir, { autoJobs: false });
const root = normalizeRootPath(rootArg);
ds.ctx.db.prepare('INSERT OR IGNORE INTO library_roots (path, enabled) VALUES (?, 1)').run(root);

const ctx: JobContext = {
  signal: new AbortController().signal,
  setTotal() {},
  advance() {},
  setMessage() {},
  shouldYield: () => false,
  requeue() {},
  yielded: false,
};
const t0 = performance.now();
ds.requests.requestFull();
const summary = await ds.scanner.scan(ctx);
ds.ctx.propagation.jobFinished('scan');
console.log(formatScanSummary(summary));
console.log(`耗时 ${((performance.now() - t0) / 1000).toFixed(2)} 秒`);
await ds.close();
