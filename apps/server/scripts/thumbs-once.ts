/**
 * 不起 HTTP，对开发库跑一遍像素处理（缩略图 + 主色 + dHash）。
 *   $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'; npx tsx apps/server/scripts/thumbs-once.ts
 */
import path from 'node:path';
import { config } from '../src/config.ts';
import type { JobContext } from '../src/core/jobs.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { ThumbnailService } from '../src/services/image/ThumbnailService.ts';

const db = openDatabase(path.join(config.dataDir, 'emaki.sqlite'));
migrate(db, { backupDir: config.dataDir, log: console.log });
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
const msg = await new ThumbnailService({ db, thumbsRoot: path.join(config.dataDir, 'thumbs', 'v1') }).runBackfill(ctx);
console.log(msg);
console.log(`耗时 ${((performance.now() - t0) / 1000).toFixed(2)} 秒`);
db.close();
