/**
 * 用户去掉的角色（character_vetoes）：手动去掉时记下，撤销时作废；合并角色时跟着搬；采纳建议跳过。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { EventBus } from '../../core/events.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { SqliteDataSource } from './SqliteDataSource.ts';
import { vetoRemovedCharacter } from './vetoes.ts';

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
    INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (1, 1, 'tagger', 0.9, '${T}'), (1, 2, 'manual', NULL, '${T}'), (2, 1, 'tagger', 0.9, '${T}');
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

it('批量移除用的 helper：只记现在挂着的，撤销后作废', async () => {
  const r = ds.ctx.mutate((u) => {
    u.set('image_characters', 'character_id = 1');
    vetoRemovedCharacter(ds.ctx.db, u, 1, [1, 2], T);
    ds.ctx.db.prepare('DELETE FROM image_characters WHERE character_id = 1').run();
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
  ds.ctx.db.exec(`
    INSERT INTO character_suggestions (image_id, danbooru_tag, score) VALUES (2, 'mika_(blue_archive)', 0.7), (2, 'hina_(blue_archive)', 0.7);
  `);
  await ds.updateSettings({ tagger: { autoAcceptThreshold: 0.65 } });
  // 保存设置不会自动归
  expect(chars(2)).toEqual([]);
  expect(await ds.promotableSuggestions()).toEqual({ images: 1, suggestions: 1, threshold: 0.65 });
  const r = await ds.promoteSuggestions();
  expect(chars(2)).toEqual([2]);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM character_suggestions').pluck().get()).toBe(0);
  await ds.undo(r.undoToken!);
  expect(chars(2)).toEqual([]);
  expect(ds.ctx.db.prepare('SELECT COUNT(*) FROM character_suggestions').pluck().get()).toBe(2);
});
