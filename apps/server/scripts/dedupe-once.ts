/**
 * 不起 HTTP，对开发库跑一遍查重（T16），打印各组。
 *   $env:EMAKI_DATA_DIR='F:/Claude/emaki/data/dev-t04'; npx tsx apps/server/scripts/dedupe-once.ts
 */
import path from 'node:path';
import { config } from '../src/config.ts';
import { openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { readSettings } from '../src/datasource/sqlite/settings.ts';
import { DedupeService } from '../src/services/dedupe/DedupeService.ts';

const db = openDatabase(path.join(config.dataDir, 'emaki.sqlite'));
migrate(db, { backupDir: config.dataDir, log: console.log });
const t0 = performance.now();
const r = new DedupeService({ db, clock: Date.now, getThreshold: () => readSettings(db).dedupe.hammingThreshold }).runOnce();
console.log(r.message);
console.log(`对账：新增 ${r.reconcile.inserted}，更新 ${r.reconcile.updated}，删除 ${r.reconcile.deleted}；耗时 ${((performance.now() - t0) / 1000).toFixed(2)} 秒`);
const name = db.prepare('SELECT rel_path FROM images WHERE id = ?').pluck();
for (const g of r.build.groups) {
  console.log(`- ${g.kind} similarity=${g.similarity.toFixed(3)} 保留 ${name.get(g.suggestedKeepId)}`);
  for (const id of g.memberIds) console.log(`    ${name.get(id)}`);
}
db.close();
