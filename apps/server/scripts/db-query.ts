/**
 * 对 ${EMAKI_DATA_DIR}/emaki.sqlite 执行一条 SQL（开发用）。
 *   npx tsx apps/server/scripts/db-query.ts "SELECT count(*) FROM images"
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../src/config.ts';

const sql = process.argv[2];
if (!sql) {
  console.error('用法：npx tsx apps/server/scripts/db-query.ts "<SQL>"');
  process.exit(1);
}
const db = new Database(path.join(config.dataDir, 'emaki.sqlite'), { fileMustExist: true });
const stmt = db.prepare(sql);
if (stmt.reader) console.table(stmt.all());
else console.log(`changes: ${stmt.run().changes}`);
db.close();
