/**
 * SQLite 连接。better-sqlite3 13.0.3 自带 SQLite 3.53.4（T13 的 unixepoch(...,'subsec') 需要 ≥ 3.42，T20 的 UPDATE … FROM 需要 ≥ 3.33）。
 */
import { searchKey } from '@emaki/shared';
import Database from 'better-sqlite3';

export type Db = Database.Database;
export type Statement = Database.Statement;

export function openDatabase(file: string): Db {
  const db = new Database(file, { timeout: 5000 }); // busy_timeout 5s
  db.pragma('journal_mode = WAL'); // ':memory:' 返回 'memory'，正常
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // 64 MB
  db.pragma('mmap_size = 268435456'); // 256 MB
  // 供 SQL 里做和 mock 一致的搜索匹配（T05 listImages 的 q 用它）
  db.function('search_key', { deterministic: true }, (s: unknown) => (s == null ? null : searchKey(String(s))));
  return db;
}

export function closeDatabase(db: Db): void {
  if (!db.open) return;
  try {
    db.pragma('optimize');
  } finally {
    db.close();
  }
}

/**
 * 在事务里跑 fn。已经在事务里（比如 ctx.mutate 的回调）就直接跑：better-sqlite3 的嵌套事务是 SAVEPOINT，
 * 同一事务里先大批改过行、再在 savepoint 里逐行写，会慢几十倍（几万行时卡几十秒）
 */
export function transact<T>(db: Db, fn: () => T): T {
  return db.inTransaction ? fn() : db.transaction(fn)();
}
