import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/events.ts';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';
import { refreshTagCounts } from './search.ts';

/** 原来的写法：从计入张数的图出发联 image_tags 分组。新写法要和它逐个一致 */
function expectedCounts(db: Db): Map<number, number> {
  const n = new Map<number, number>();
  for (const [id, c] of db
    .prepare('SELECT it.tag_id, COUNT(*) FROM image_tags it JOIN v_counted_images i ON i.id = it.image_id GROUP BY it.tag_id')
    .raw()
    .all() as [number, number][])
    n.set(id, c);
  return n;
}

function actualCounts(db: Db): Map<number, number> {
  return new Map((db.prepare('SELECT id, image_count FROM tags WHERE image_count <> 0').raw().all() as [number, number][]).map(([id, c]) => [id, c]));
}

describe('refreshTagCounts', () => {
  it('总数减去不计数的图：排除、回收站、丢失、文件夹停用 / 移除的都不算，只写变了的行', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0), (3, 'D:/c', 1);
      UPDATE library_roots SET removed_at = 'x' WHERE id = 3;
      INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 'x', 'x', 'x');`);
    const tag = db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'general')");
    for (let t = 1; t <= 12; t++) tag.run(t, `t${t}`);
    const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
        excluded_by, missing, trashed_at) VALUES (?, ?, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', ?, ?, ?)`);
    const addTag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.9)');
    db.transaction(() => {
      for (let id = 1; id <= 300; id++) {
        const root = id % 9 === 0 ? 2 : id % 11 === 0 ? 3 : 1;
        img.run(id, root, `${id}.png`, `s${id}`, id % 5 === 0 ? 1 : null, id % 13 === 0 ? 1 : 0, id % 17 === 0 ? 'x' : null);
        for (let t = 1; t <= 12; t++) if ((id * t) % 7 < 3 || t === 12) addTag.run(id, t);
      }
    })();
    // t11 只出现在不计数的图上，应当是 0
    db.prepare('DELETE FROM image_tags WHERE tag_id = 11 AND image_id IN (SELECT id FROM v_counted_images)').run();
    db.prepare('UPDATE tags SET image_count = 99 WHERE id = 11').run();

    refreshTagCounts(db);
    const want = expectedCounts(db);
    expect(want.size).toBeGreaterThan(5);
    expect(actualCounts(db)).toEqual(want);
    expect(db.prepare('SELECT image_count FROM tags WHERE id = 11').pluck().get()).toBe(0);

    // 再改一张图：只有它的标签那几行被写
    db.exec(`CREATE TEMP TABLE writes (id INTEGER);
      CREATE TEMP TRIGGER tw AFTER UPDATE OF image_count ON tags BEGIN INSERT INTO writes VALUES (new.id); END;`);
    db.prepare("UPDATE images SET trashed_at = 'y' WHERE id = 1").run();
    const tagsOf1 = db.prepare('SELECT tag_id FROM image_tags WHERE image_id = 1 ORDER BY tag_id').pluck().all();
    refreshTagCounts(db);
    expect(actualCounts(db)).toEqual(expectedCounts(db));
    expect(db.prepare('SELECT id FROM writes ORDER BY id').pluck().all()).toEqual(tagsOf1);
  });
});

describe('搜索的标签张数', () => {
  it('图库有变化只标记过期，下次搜索时才刷新（后台不再定时重算）', async () => {
    const dataDir = makeTmpDir('search');
    const bus = new EventBus();
    const ds = await SqliteDataSource.open(bus, dataDir, { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO tags (id, name, category) VALUES (1, 'thighhighs', 'general');`);
    for (let id = 1; id <= 3; id++) {
      db.prepare(
        `INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
         VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x')`,
      ).run(id, `${id}.png`, `s${id}`);
      db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, 1, 0.9)').run(id);
    }
    const hit = async () => {
      const h = (await ds.search({ q: 'thighhighs' })).find((x) => x.type === 'tag');
      return h?.type === 'tag' ? h.imageCount : 0;
    };
    const stored = () => db.prepare("SELECT image_count FROM tags WHERE name = 'thighhighs'").pluck().get();
    expect(await hit()).toBe(3);

    db.prepare("UPDATE images SET trashed_at = 'x' WHERE id = 1").run();
    bus.emit({ type: 'library-changed', reason: 'scan' });
    expect(stored()).toBe(3); // 只是标记了
    expect(await hit()).toBe(2); // 不用等计时器，下一次搜索就是新的
    expect(stored()).toBe(2);
    expect((await ds.tagSuggestions({ q: 'thigh' })).map((t) => t.count)).toEqual([2]);

    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('一句话拆标签 / ⌘K 中文标签', () => {
  it('只认库里有图的标签；张数、总数和「必含」同一口径（分数够才算）', async () => {
    const dataDir = makeTmpDir('phrase');
    const ds = await SqliteDataSource.open(new EventBus(), dataDir, { memory: true, autoJobs: false, importDict: false });
    const db = ds.ctx.db;
    db.exec(`INSERT INTO library_roots (id, path) VALUES (1, 'D:/x');
      INSERT INTO tags (id, name, category) VALUES (1, '2girls', 'general'), (2, 'black_hair', 'general'), (3, 'long_hair', 'general'), (4, 'twintails', 'general');
      INSERT INTO tag_i18n (tag, category, zh, aliases) VALUES ('2girls', 0, '两个女孩', '[]'), ('black_hair', 0, '黑发', '["黑毛"]'),
        ('long_hair', 0, '长发', '[]'), ('twintails', 0, '双马尾', '[]'), ('blonde_hair', 0, '金发', '[]');`);
    // 1–3 张：2girls + black_hair + long_hair；第 3 张 black_hair 分数不够；第 4 张只有 long_hair；双马尾只在不达标的分数上
    const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at, tagged_at)
      VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x', 'x')`);
    const tag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, ?)');
    for (let id = 1; id <= 4; id++) img.run(id, `${id}.png`, `s${id}`);
    for (const id of [1, 2, 3]) tag.run(id, 1, 0.9), tag.run(id, 2, id === 3 ? 0.3 : 0.9), tag.run(id, 3, 0.9);
    tag.run(4, 3, 0.9);
    tag.run(4, 4, 0.2);

    const r = await ds.tagPhrase({ q: '两个黑色长发女孩' });
    expect(r.tags).toEqual([
      { tag: '2girls', name: '两个女孩', count: 3 },
      { tag: 'black_hair', name: '黑发', count: 2 },
      { tag: 'long_hair', name: '长发', count: 4 },
    ]);
    expect(r).toMatchObject({ rest: '', total: 2 });
    expect(r.total).toBe((await ds.listImages({ tagsAll: ['2girls', 'black_hair', 'long_hair'], limit: 1 })).total);
    // 金发库里没有图、双马尾分数都不够：都不认，留在 rest
    expect(await ds.tagPhrase({ q: '金发双马尾' })).toEqual({ tags: [], rest: '金发双马尾', total: 0 });

    // ⌘K：中文名、别名也能搜到标签，带中文显示名
    const hits = (await ds.search({ q: '黑毛' })).filter((h) => h.type === 'tag');
    expect(hits).toEqual([{ type: 'tag', tag: 'black_hair', name: '黑发', imageCount: 3 }]);

    await ds.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
