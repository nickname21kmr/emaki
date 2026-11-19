/**
 * 用户去掉的角色（character_vetoes）：手动去掉时记下，撤销时作废；合并角色时跟着搬；采纳建议跳过。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from '../../../test/helpers/client.ts';
import { unlinkByUser } from '../../domain/curation/links.ts';

const T = '2026-01-01T00:00:00.000Z';
let ds: SqliteDataSource;
let dir: string;
const vetoes = () => ds.ctx.db.prepare('SELECT image_id, character_id FROM character_vetoes ORDER BY image_id, character_id').all();
const chars = (img: number) => ds.ctx.db.prepare('SELECT character_id FROM image_characters WHERE image_id = ? ORDER BY character_id').pluck().all(img);

beforeEach(async () => {
  dir = makeTmpDir('vetoes');
  ds = await SqliteDataSource.open(new EventBus(), dir, { memory: true, autoJobs: false, importDict: false, clock: () => Date.parse(T) });
  ds.ctx.db.exec(`
    INSERT INTO library_roots (id, path) VALUES (1, 'D:/a');
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '未花', 'mika_(blue_archive)', 'danbooru', '${T}'), (2, '日奈', 'hina_(blue_archive)', 'danbooru', '${T}');
    INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
      VALUES (1, 1, '1.png', '1.png', 10, 10, 1, 'png', 's1', '${T}', '${T}'), (2, 1, '2.png', '2.png', 10, 10, 1, 'png', 's2', '${T}', '${T}');
    INSERT INTO image_characters (image_id, character_id, decision, actor, rule, evidence_provider, evidence_score, added_at) VALUES
      (1, 1, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 0.9, '${T}'), (1, 2, 'manual', 'user', NULL, NULL, NULL, '${T}'),
      (2, 1, 'auto', 'job:tag', 'auto-accept@1', 'tagger', 0.9, '${T}');
  `);
  ds.ctx.invalidate();
});
afterEach(async () => {
  await ds.close();
  rmSync(dir, { recursive: true, force: true });
});

it('详情里去掉角色：记下，撤销后作废', async () => {
  const r = await ds.updateImage('1', { characterIds: ['2'] });
  expect(vetoes()).toEqual([{ image_id: 1, character_id: 1 }]);
  expect(chars(1)).toEqual([2]);
  await ds.undo(r.undoToken!);
  expect(vetoes()).toEqual([]);
  expect(chars(1)).toEqual([1, 2]);
});

it('归类模块的「用户去掉」：只记现在挂着的，撤销后作废', async () => {
  const r = ds.ctx.mutate((u) => {
    unlinkByUser(ds.ctx, u, [1, 2, 3], [1], T);
    return { message: 'x' };
  });
  expect(vetoes()).toEqual([{ image_id: 1, character_id: 1 }, { image_id: 2, character_id: 1 }]);
  await ds.undo(r.undoToken!);
  expect(vetoes()).toEqual([]);
  expect(chars(2)).toEqual([1]);
});

it('合并角色：被合并角色的记录搬到目标上，撤销后还原', async () => {
  await ds.updateImage('2', { characterIds: [] });
  expect(vetoes()).toEqual([{ image_id: 2, character_id: 1 }]);
  const r = await ds.mergeCharacter('1', '2');
  expect(vetoes()).toEqual([{ image_id: 2, character_id: 2 }]);
  await ds.undo(r.undoToken!);
  expect(vetoes()).toEqual([{ image_id: 2, character_id: 1 }]);
});

it('调低阈值后的采纳按钮：跳过去掉过的角色，那条建议删掉；可撤销', async () => {
  await ds.updateImage('2', { characterIds: [] });
  // 模型证据是识别这份文件得到的（识别时间有值；文件变了、还没重新识别的证据是过期的，不拿来自动关联，D1）
  ds.ctx.db.exec(`
    UPDATE images SET tagged_at = '${T}' WHERE id = 2;
    INSERT INTO character_evidence (image_id, tag, score, provider) VALUES (2, 'mika_(blue_archive)', 0.7, 'tagger'), (2, 'hina_(blue_archive)', 0.7, 'tagger');
  `);
  await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.65 } });
  // 保存设置不会自动归
  expect(chars(2)).toEqual([]);
  expect(await ds.promotableSuggestions()).toEqual({ images: 1, suggestions: 1, threshold: 0.65 });
  const r = await ds.promoteSuggestions();
  expect(chars(2)).toEqual([2]);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM v_character_suggestions').pluck().get()).toBe(0);
  await ds.undo(r.undoToken!);
  expect(chars(2)).toEqual([]);
  // 建议是派生的（附录 #9）：去掉过的角色（否决）不再算建议，只剩 hina；证据两条都还在
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM v_character_suggestions').pluck().get()).toBe(1);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM character_evidence WHERE image_id = 2').pluck().get()).toBe(2);
});

it('旧建议补采纳支持动的插画建档和别册复用，合并标签只计一次并保留最高分', async () => {
  await ds.updateImage('1', { characterIds: ['2'] });
  await ds.updateImage('2', { characterIds: [] });
  const db = ds.ctx.db;
  db.exec(`
    UPDATE images SET tagged_at = '${T}';
    UPDATE images SET format = 'gif', frame_count = 12, animated = 1 WHERE id = 1;
    UPDATE images SET content_kind = 'screenshot' WHERE id = 2;
    INSERT INTO danbooru_tag_redirects (tag, character_id) VALUES ('merged_mika', 1);
    INSERT INTO character_evidence (image_id, tag, score, provider) VALUES
      (1, 'new_character', 0.91, 'tagger'), (2, 'new_character', 0.96, 'tagger'),
      (2, 'merged_mika', 0.99, 'tagger'), (2, 'hina_(blue_archive)', 0.88, 'tagger'),
      (1, 'merged_hina', 0.92, 'tagger'), (2, 'merged_hina', 0.95, 'tagger'),
      (2, 'unknown_screenshot', 0.99, 'tagger'), (1, 'pixiv_character', 0, 'pixiv');
    INSERT INTO danbooru_tag_redirects (tag, character_id) VALUES ('merged_hina', 2);
  `);
  expect(await ds.promotableSuggestions('illustration')).toEqual({ images: 0, suggestions: 0, threshold: 0.85 });
  expect(await ds.promotableSuggestions('screenshot')).toEqual({ images: 1, suggestions: 1, threshold: 0.85 });
  expect(await ds.promotableSuggestions()).toEqual({ images: 2, suggestions: 3, threshold: 0.85 });
  const r = await ds.promoteSuggestions();
  const created = db.prepare("SELECT id FROM characters WHERE danbooru_tag = 'new_character'").pluck().get();
  expect(chars(1)).toEqual([2, created]);
  expect(chars(2)).toEqual([2, created]);
  expect(db.prepare('SELECT evidence_score FROM image_characters WHERE image_id = 2 AND character_id = 2').pluck().get()).toBe(0.95);
  expect(db.prepare('SELECT danbooru_tag FROM v_character_suggestions ORDER BY danbooru_tag').pluck().all()).toEqual(['pixiv_character', 'unknown_screenshot']);
  expect(await ds.promotableSuggestions()).toEqual({ images: 0, suggestions: 0, threshold: 0.85 });
  await ds.undo(r.undoToken!);
  expect(chars(1)).toEqual([2]);
  expect(chars(2)).toEqual([]);
  // 证据 8 条原样回来；派生的建议不含已经关联（图 1 的 merged_hina → 日奈）和去掉过（图 2 的 merged_mika → 未花）的角色（附录 #9）
  expect(db.prepare('SELECT COUNT(*) FROM character_evidence').pluck().get()).toBe(8);
  expect(db.prepare('SELECT COUNT(*) FROM v_character_suggestions').pluck().get()).toBe(6);
});
