/**
 * 领域模块写事实时共用的最小上下文：数据库 + 声明变化。
 * 调用方在 ctx.mutate / ctx.apply 里调用时直接传 ctx；反应里传 { db, changed: emit }；
 * 自己开事务的批量写入（识别写入）传一个收集变化的 tx，批后再交给 ctx.apply 声明。
 */
import type { Db, Statement } from '../db/connection.ts';
import type { Change } from '../propagation/changes.ts';

export interface DomainTx {
  readonly db: Db;
  changed(c: Change): void;
}

/** 收集变化的 tx：自己开事务的写入先收着，批后交给 ctx.apply 声明 */
export function collectingTx(db: Db): DomainTx & { changes: Change[] } {
  const changes: Change[] = [];
  return { db, changes, changed: (c) => void changes.push(c) };
}

const cache = new WeakMap<Db, Map<string, Statement>>();

/** 按库缓存的预编译语句：同一段 SQL 只 prepare 一次 */
export function stmt(db: Db, sql: string): Statement {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}
