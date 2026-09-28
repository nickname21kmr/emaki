import type { Db } from './connection.ts';

/** 这几张表的行数最影响查询计划：图片列表、画面筛选 / 搜索、按角色找图、未识别建议 */
const TABLES = ['images', 'image_tags', 'image_characters', 'character_suggestions'] as const;
/** 实际行数和统计信息里记的差到这个倍数就重新采样 */
const DRIFT = 1.5;

/**
 * 查询计划靠 sqlite_stat1 估行数。`PRAGMA optimize` 只在表涨了 10 倍时才重新 ANALYZE，
 * 首次导入后的库（几千张时采的统计，现在 8 万张）会一直走错计划：首页先把全表排序一遍，慢 1000 倍（T22 实测）。
 * 这里在行数偏差超过 1.5 倍时完整地重新 ANALYZE（8 万张图、240 万条标签约 1.2 秒，只在行数大变时跑）。
 * 不用 analysis_limit 限量采样：实测会把「excluded_by IS NULL」估成两百行（实际八万），首页又去走排除索引、整表排序。返回是否重新统计了。
 */
export function refreshPlannerStats(db: Db, opts: { force?: boolean } = {}): boolean {
  const recorded = new Map<string, number>();
  try {
    for (const r of db.prepare('SELECT tbl, stat FROM sqlite_stat1 WHERE idx IS NOT NULL').all() as { tbl: string; stat: string }[]) {
      if (!recorded.has(r.tbl)) recorded.set(r.tbl, Number(r.stat.split(' ')[0]));
    }
  } catch {
    // 还没有 sqlite_stat1：下面一定会采样
  }
  const stale =
    opts.force ||
    TABLES.some((t) => {
      const actual = db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number;
      const was = recorded.get(t);
      if (was === undefined) return actual > 1000;
      const [a, b] = [Math.max(actual, 1), Math.max(was, 1)];
      return Math.max(a, b) / Math.min(a, b) > DRIFT && Math.abs(actual - was) > 1000;
    });
  if (!stale) return false;
  db.exec('ANALYZE');
  return true;
}
