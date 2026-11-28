import type { Db } from './connection.ts';

/** 这几张表的行数最影响查询计划：图片列表、画面筛选 / 搜索、按角色找图、未识别建议 */
const TABLES = ['images', 'image_tags', 'image_characters', 'character_evidence'] as const;
/** 实际行数和统计信息里记的差到这个倍数就重新采样 */
const DRIFT = 1.5;

/**
 * 上次 ANALYZE 时各表的行数，从 sqlite_stat1 读（没采过样的表、空表不在里面）。每行是一个索引，第一个数是索引里的行数；
 * 同一张表取最大的：完整索引的行数就是表的行数，部分索引（带 WHERE）只数它收的那些行，
 * 没有完整索引的表另有一行 idx 为空的，记的就是表的行数。
 * 不能只看每张表的第一行：ANALYZE 把最后建的索引写在最前面，迁移 035、038 加的部分索引正好排第一（十万张图的库里只有几百行），
 * 于是每次都判成「行数大变」，启动、每小时、每次扫描结束各白白重新采样一两秒（2026-11-28 修）
 */
export function analyzedRowCounts(db: Db): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    for (const r of db.prepare('SELECT tbl, stat FROM sqlite_stat1').all() as { tbl: string; stat: string }[]) {
      counts.set(r.tbl, Math.max(counts.get(r.tbl) ?? 0, Number.parseInt(r.stat, 10) || 0));
    }
  } catch {
    // 还没有 sqlite_stat1：表里超过一千行的话 refreshPlannerStats 会采样
  }
  return counts;
}

/**
 * 查询计划靠 sqlite_stat1 估行数。`PRAGMA optimize` 只在表涨了 10 倍时才重新 ANALYZE，
 * 首次导入后的库（几千张时采的统计，现在 8 万张）会一直走错计划：首页先把全表排序一遍，慢 1000 倍（T22 实测）。
 * 这里在行数偏差超过 1.5 倍时完整地重新 ANALYZE（8 万张图、240 万条标签约 1.2 秒，只在行数大变时跑）。
 * 不用 analysis_limit 限量采样：实测会把「excluded_by IS NULL」估成两百行（实际八万），首页又去走排除索引、整表排序。返回是否重新统计了。
 * skipImageTags：不精确数 image_tags（330 万行，冷启动时要把 70 MB 的主键索引整个读一遍，2 秒多）。
 * 启动时、扫描结束时用：它只随识别任务变多，识别跑完和每小时那次会照常数
 */
export function refreshPlannerStats(db: Db, opts: { force?: boolean; skipImageTags?: boolean } = {}): boolean {
  const recorded = analyzedRowCounts(db);
  const tables = opts.skipImageTags ? TABLES.filter((t) => t !== 'image_tags') : TABLES;
  const stale =
    opts.force ||
    tables.some((t) => {
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
