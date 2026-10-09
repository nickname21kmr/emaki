import { expect, it } from 'vitest';
import { openDatabase } from './connection.ts';
import { migrate } from './migrate.ts';
import { refreshPlannerStats } from './plannerStats.ts';

it('skipImageTags：启动时不数 image_tags，只有它涨了就不重新采样；不跳过时照常采样', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  db.exec("INSERT INTO library_roots (id, path) VALUES (1, 'D:/a')");
  const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
    VALUES (?, 1, ?, 'a.png', 1, 1, 1, 'png', ?, 'x', 'x')`);
  const tag = db.prepare("INSERT INTO tags (id, name, category) VALUES (?, ?, 'general')");
  const addTag = db.prepare('INSERT INTO image_tags (image_id, tag_id, score) VALUES (?, ?, 0.9)');
  db.transaction(() => {
    for (let t = 1; t <= 60; t++) tag.run(t, `t${t}`);
    for (let id = 1; id <= 100; id++) {
      img.run(id, `${id}.png`, `s${id}`);
      for (let t = 1; t <= 20; t++) addTag.run(id, t);
    }
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
