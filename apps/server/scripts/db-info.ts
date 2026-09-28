/**
 * 查看数据库结构和行数（只读）。
 *   npx tsx apps/server/scripts/db-info.ts <dataDir>
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('用法：npx tsx apps/server/scripts/db-info.ts <dataDir>');
  process.exit(1);
}
const file = path.join(dataDir, 'emaki.sqlite');
if (!existsSync(file)) {
  console.error(`找不到数据库：${file}`);
  process.exit(1);
}

const db = new Database(file, { readonly: true, fileMustExist: true });
console.log(`文件         ${file}`);
console.log(`user_version ${db.pragma('user_version', { simple: true })}`);
console.log(`journal_mode ${db.pragma('journal_mode', { simple: true })}`);
console.log(`sqlite       ${(db.prepare('select sqlite_version() v').get() as { v: string }).v}`);

const objects = db
  .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
  .all() as { type: 'table' | 'view'; name: string }[];

const rows = objects.map((o) => {
  const count = (db.prepare(`SELECT count(*) n FROM "${o.name}"`).get() as { n: number }).n;
  const cols = (db.prepare(`PRAGMA table_info("${o.name}")`).all() as { name: string }[]).map((c) => c.name);
  return { 类型: o.type, 名称: o.name, 行数: count, 列: cols.join(', ') };
});
console.table(rows);
db.close();
