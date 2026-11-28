import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.ts';
import { migrate } from './migrate.ts';
import { analyzedRowCounts, refreshPlannerStats } from './plannerStats.ts';

/** 迁移到最新的内存库，加一个文件夹；addImages(从, 到, 动图几张) 插一段图 */
function library() {
  const db = openDatabase(':memory:');
  migrate(db);
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'D:/a')");
  const img = db.prepare(`INSERT INTO images
    (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, animated)
    VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', ?)`);
  const addImages = db.transaction((from: number, to: number, animated = 0) => {
    for (let id = from; id <= to; id++) img.run(id, `${id}.png`, `s${id}`, id < from + animated ? 1 : 0);
  });
  return { db, addImages };
}

it('skipImageTags：启动时不数 image_tags，只有它涨了就不重新采样；不跳过时照常采样', () => {
  const { db, addImages } = library();
  const tag = db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'general')");
  const addTag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.9)');
  addImages(1, 100);
  db.transaction(() => {
    for (let t = 1; t <= 60; t++) tag.run(t, `t${t}`);
    for (let id = 1; id <= 100; id++) for (let t = 1; t <= 20; t++) addTag.run(id, t);
  })();
  expect(refreshPlannerStats(db, { force: true })).toBe(true);
  expect(refreshPlannerStats(db)).toBe(false);

  // 识别后标签变成三倍，图片数没变
  db.transaction(() => {
    for (let id = 1; id <= 100; id++) for (let t = 21; t <= 60; t++) addTag.run(id, t);
  })();
  expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(false);
  expect(refreshPlannerStats(db)).toBe(true);
  expect(refreshPlannerStats(db)).toBe(false);
});

// 判断里有一条「差 1000 行以上」，不到一千行的表怎么判都不会重新采样：下面几条都要超过 1000 行才测得到东西
describe('行数没变就不重新采样（表上有部分索引：它的行数比表少得多，不能当成表的行数）', () => {
  it('images：动图的部分索引里只有 5 行，表里 1500 行', () => {
    const { db, addImages } = library();
    addImages(1, 1500, 5);
    expect(refreshPlannerStats(db, { force: true })).toBe(true);
    expect(analyzedRowCounts(db).get('images')).toBe(1500);
    expect(refreshPlannerStats(db)).toBe(false);
    expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(false);
  });

  it('character_evidence：候选都没对上角色，部分索引里一行也没有，表里 1500 行', () => {
    const { db, addImages } = library();
    addImages(1, 100);
    const evidence = db.prepare(
      "INSERT INTO character_evidence (image_id, provider, tag, character_id, score) VALUES (?, 'model', ?, NULL, 0.9)",
    );
    db.transaction(() => {
      for (let id = 1; id <= 100; id++) for (let t = 1; t <= 15; t++) evidence.run(id, `tag_${t}`);
    })();
    expect(refreshPlannerStats(db, { force: true })).toBe(true);
    expect(analyzedRowCounts(db).get('character_evidence')).toBe(1500);
    expect(refreshPlannerStats(db)).toBe(false);
    expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(false);
  });

  it('图真的多了一倍多才重新采样，采完又是最新的', () => {
    const { db, addImages } = library();
    addImages(1, 1500, 5);
    expect(refreshPlannerStats(db, { force: true })).toBe(true);
    // 多了不到一半：不采
    addImages(1501, 2200);
    expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(false);
    addImages(2201, 3100);
    expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(true);
    expect(refreshPlannerStats(db, { skipImageTags: true })).toBe(false);
    expect(refreshPlannerStats(db)).toBe(false);
  });
});

describe('analyzedRowCounts：从 sqlite_stat1 读出采样时各表的行数', () => {
  const fill = (db: Db, table: string, rows: number) => {
    const st = db.prepare(`INSERT INTO ${table} (a, b) VALUES (?, ?)`);
    db.transaction(() => {
      // 前 5 行 b = 1（进部分索引），其余是 NULL
      for (let i = 1; i <= rows; i++) st.run(`k${i}`, i <= 5 ? 1 : null);
    })();
  };

  it('还没采过样：什么也没有', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (a TEXT, b INT)');
    expect(analyzedRowCounts(db).size).toBe(0);
  });

  it('不管索引怎么建，读出来的都是表的行数；空表不在里面', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE full_then_partial (a TEXT, b INT);
      CREATE INDEX ftp_a ON full_then_partial(a);
      CREATE INDEX ftp_b ON full_then_partial(b) WHERE b = 1;
      CREATE TABLE only_partial (a TEXT, b INT);
      CREATE INDEX op_b ON only_partial(b) WHERE b = 1;
      CREATE TABLE no_index (a TEXT, b INT);
      CREATE TABLE keyed (a TEXT PRIMARY KEY, b INT) WITHOUT ROWID;
      CREATE INDEX keyed_b ON keyed(b) WHERE b IS NOT NULL;
      CREATE TABLE empty (a TEXT, b INT);
      CREATE INDEX empty_a ON empty(a);
    `);
    for (const t of ['full_then_partial', 'only_partial', 'no_index', 'keyed']) fill(db, t, 2000);
    db.exec('ANALYZE');
    // 这两张表各有一行统计是部分索引的，只有 5 行
    const stats = (tbl: string) => db.prepare('SELECT stat FROM sqlite_stat1 WHERE tbl = ?').pluck().all(tbl) as string[];
    const smallest = (tbl: string) => Math.min(...stats(tbl).map((s) => Number.parseInt(s, 10)));
    expect(smallest('full_then_partial')).toBe(5);
    expect(smallest('keyed')).toBe(5);
    expect(Object.fromEntries(analyzedRowCounts(db))).toEqual({ full_then_partial: 2000, only_partial: 2000, no_index: 2000, keyed: 2000 });
  });
});
