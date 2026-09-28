/**
 * 不起 HTTP，直接对开发库扫描一个文件夹。
 *   $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t03'; npx tsx apps/server/scripts/scan-once.ts <rootPath>
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { EventBus } from '../src/core/events.ts';
import type { JobContext } from '../src/core/jobs.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { normalizeRootPath } from '../src/datasource/sqlite/settings.ts';
import { formatScanSummary, Scanner } from '../src/services/scan/Scanner.ts';
import { ScanRequests } from '../src/services/scan/ScanRequests.ts';

const rootArg = process.argv[2];
if (!rootArg) {
  console.error('用法：npx tsx apps/server/scripts/scan-once.ts <rootPath>');
  process.exit(1);
}
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(path.join(config.dataDir, 'emaki.sqlite'));
migrate(db, { backupDir: config.dataDir, log: console.log });
const root = normalizeRootPath(rootArg);
db.prepare('INSERT OR IGNORE INTO library_roots (path, enabled) VALUES (?, 1)').run(root);

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
const summary = await new Scanner({ db, bus: new EventBus(), dataDir: config.dataDir, requests: new ScanRequests() }).scan(ctx);
console.log(formatScanSummary(summary));
console.log(`耗时 ${((performance.now() - t0) / 1000).toFixed(2)} 秒`);
db.close();
