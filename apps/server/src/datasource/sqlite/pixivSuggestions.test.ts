/**
 * Pixiv 给自建角色的建议（sqlite 专属）：danbooru_tag 写 emaki:character:<id> 只当主键占位，真正的引用是 character_id 外键。
 * 合并时跟着搬到目标、可撤销；角色删掉后建议跟着没；编号被新角色复用后旧建议不会指过去。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { dumpCore } from '../../../test/helpers/dump.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import { CharacterCatalog } from '../../services/catalog/characterCatalog.ts';
import type { SqliteDataSource } from './SqliteDataSource.ts';
import { pendingPixivCount, queuePixivImages } from '../../services/pixiv/sync.ts';

let env: ContractEnv;
let ds: SqliteDataSource;
beforeEach(async () => {
  env = await sqliteFactory();
  ds = env.ds as SqliteDataSource;
});
afterEach(() => env.close());
const db = () => ds.ctx.db;
const c = (id: string) => env.id('character', id);
const img = (id: string) => env.id('image', id);

/** 像 pixiv 任务那样写一条自建角色建议 */
const pixiv = (image: string, characterId: string) =>
  db()
    .prepare("INSERT INTO character_suggestions (image_id, danbooru_tag, character_id, score, source) VALUES (?, ?, ?, 0, 'pixiv')")
    .run(Number(img(image)), CharacterCatalog.customTag(Number(characterId)), Number(characterId));
const sugs = async (image: string) =>
  (await ds.getImage(img(image)))!.characterSuggestions.map((s) => [s.name, s.characterId === null ? null : env.back('character', s.characterId)]);
const custom = async (name: string) => (await ds.createCharacter({ name, workIds: [] })).character.id;

it('按 character_id 显示真名；没有 character_id 的占位行不显示', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  db().prepare("INSERT INTO character_suggestions (image_id, danbooru_tag, score, source) VALUES (?, 'emaki:character:999', 0, 'pixiv')").run(Number(img('i27')));
  expect(await sugs('i27')).toEqual([
    ['Test Girl', null],
    ['小雪', x],
  ]);
  expect((await ds.getImage(img('i27')))!.characterSuggestions.map(s => s.source)).toEqual(['tagger', 'pixiv']);
});

it('已经归到这个自建角色的图不再显示它的建议', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  await ds.updateImage(img('i27'), { characterIds: [x] });
  expect(await sugs('i27')).toEqual([['Test Girl', null]]);
});

it('采纳自建角色的建议：按 character_id 归入，可撤销', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  const before = dumpCore(db());
  const r = await ds.acceptSuggestion(img('i27'), CharacterCatalog.customTag(Number(x)));
  expect(r.message).toBe('已归到「小雪」');
  expect((await ds.getImage(img('i27')))!.characterIds).toEqual([x]);
  await ds.undo(r.undoToken!);
  expect(dumpCore(db())).toEqual(before);
});

it('合并：自建角色的建议改指向目标（目标是自建角色），撤销后逐行还原', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  const before = dumpCore(db());
  const r = await ds.mergeCharacter(x, c('c7'));
  expect(await sugs('i27')).toEqual([
    ['Test Girl', null],
    ['雪见', 'c7'],
  ]);
  expect(db().prepare('SELECT danbooru_tag FROM character_suggestions WHERE character_id = ?').pluck().all(Number(c('c7')))).toEqual([
    CharacterCatalog.customTag(Number(c('c7'))),
  ]);
  await ds.undo(r.undoToken!);
  expect(dumpCore(db())).toEqual(before);
});

it('合并进 Danbooru 角色：图上已有目标的建议就不重复，撤销后逐行还原', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  pixiv('i28', x); // i28 已有 hina_(blue_archive) 的建议
  const before = dumpCore(db());
  const r = await ds.mergeCharacter(x, c('c3'));
  expect(await sugs('i27')).toEqual([
    ['Test Girl', null],
    ['空崎日奈', 'c3'],
  ]);
  expect(await sugs('i28')).toEqual([['空崎日奈', 'c3']]);
  expect(db().prepare('SELECT count(*) FROM character_suggestions WHERE image_id = ?').pluck().get(Number(img('i28')))).toBe(1);
  // 目标有 Danbooru 标签：搬过去写成标签，和识别器、之后再跑 Pixiv 写的同一行
  expect(db().prepare("SELECT danbooru_tag, character_id, source FROM character_suggestions WHERE image_id = ? AND source = 'pixiv'").all(Number(img('i27')))).toEqual([
    { danbooru_tag: 'hina_(blue_archive)', character_id: null, source: 'pixiv' },
  ]);
  await ds.undo(r.undoToken!);
  expect(dumpCore(db())).toEqual(before);
});

it('合并：被合并的角色后来补了 Danbooru 标签、目标没有：目标接过标签，建议跟着写成标签', async () => {
  const x = await custom('小雪');
  pixiv('i27', x);
  await ds.updateCharacter(x, { danbooruTag: 'koyuki_(emaki_test)' });
  const before = dumpCore(db());
  const r = await ds.mergeCharacter(x, c('c7'));
  expect(await sugs('i27')).toEqual([
    ['Test Girl', null],
    ['雪见', 'c7'],
  ]);
  expect(db().prepare("SELECT danbooru_tag, character_id FROM character_suggestions WHERE source = 'pixiv'").all()).toEqual([
    { danbooru_tag: 'koyuki_(emaki_test)', character_id: null },
  ]);
  await ds.undo(r.undoToken!);
  expect(dumpCore(db())).toEqual(before);
});

it('编号被新角色复用：旧建议不会指过去，拿旧占位标签采纳报 409，不新建角色', async () => {
  const x = await custom('小雪'); // 新建的 id 最大，合并删掉后会被下一个新角色拿走
  pixiv('i27', x);
  await ds.mergeCharacter(x, c('c7'));
  const reused = await custom('全く別の人');
  expect(reused).toBe(x);
  expect(await sugs('i27')).toEqual([
    ['Test Girl', null],
    ['雪见', 'c7'],
  ]);
  const count = db().prepare('SELECT count(*) FROM characters').pluck().get();
  await expect(ds.acceptSuggestion(img('i27'), CharacterCatalog.customTag(Number(x)))).rejects.toMatchObject({ statusCode: 409 });
  expect(db().prepare('SELECT count(*) FROM characters').pluck().get()).toBe(count);
  expect((await ds.getImage(img('i27')))!.characterIds).toEqual([]);
});

it('撤销新建自建角色：它的建议跟着级联删掉；之后拿占位标签采纳报 409', async () => {
  const made = await ds.createCharacter({ name: '小雪', workIds: [] });
  pixiv('i27', made.character.id);
  await ds.undo(made.undoToken!);
  expect(await sugs('i27')).toEqual([['Test Girl', null]]);
  await expect(ds.acceptSuggestion(img('i27'), CharacterCatalog.customTag(Number(made.character.id)))).rejects.toMatchObject({ statusCode: 409 });
  expect(db().prepare("SELECT count(*) FROM characters WHERE name LIKE 'Emaki%'").pluck().get()).toBe(0);
});

it('改类型提升建议只看识别器的：Pixiv 建议分数再高也不提升', async () => {
  const x = await custom('小雪');
  pixiv('i24', x);
  db().prepare("UPDATE character_suggestions SET score = 0.99 WHERE image_id = ? AND source = 'pixiv'").run(Number(img('i24')));
  await ds.bulkImages({ ids: [img('i24')], action: { type: 'kind', value: 'screenshot' } });
  await ds.bulkImages({ ids: [img('i24')], action: { type: 'kind', value: 'illustration' } });
  expect((await ds.getImage(img('i24')))!.characterIds).not.toContain(x);
});

it.each(['bulk','image'])('人工移除角色后保留其他建议，%s 操作的移除标记也能撤销', async via => {
  const id=Number(img('i27')), character=c('c3'), other=await custom('另一个建议');
  db().prepare("UPDATE images SET source_site='pixiv',source_post_id='123',content_kind='illustration' WHERE id=?").run(id);
  await ds.bulkImages({ids:[img('i27')],action:{type:'assign',characterId:character}});
  pixiv('i27',other);
  db().prepare("INSERT INTO pixiv_character_checks(image_id,post_id,modified_at,checked_at,result) SELECT id,source_post_id,modified_at,'before','suggested' FROM images WHERE id=?").run(id);
  const before=db().prepare('SELECT * FROM pixiv_character_checks WHERE image_id=?').get(id);
  const removed=via==='bulk'
    ? await ds.bulkImages({ids:[img('i27')],action:{type:'unassign',characterId:character}})
    : await ds.updateImage(img('i27'),{characterIds:[]});
  expect(db().prepare('SELECT result FROM pixiv_character_checks WHERE image_id=?').pluck().get(id)).toBe('dismissed');
  expect(db().prepare('SELECT COUNT(*) FROM character_suggestions WHERE image_id=?').pluck().get(id)).toBeGreaterThan(0);
  queuePixivImages(ds.ctx);
  expect(pendingPixivCount(ds.ctx)).toBe(0);
  await ds.undo(removed.undoToken!);
  expect(db().prepare('SELECT * FROM pixiv_character_checks WHERE image_id=?').get(id)).toEqual(before);
  expect((await ds.getImage(img('i27')))!.characterIds).toContain(character);
});

it('第一次查询前移除角色也有记录，撤销后还原为没有记录；无实际移除不标记', async () => {
  const id=Number(img('i27')), character=c('c3');
  db().prepare("UPDATE images SET source_site='pixiv',source_post_id='123' WHERE id=?").run(id);
  await ds.bulkImages({ids:[img('i27')],action:{type:'unassign',characterId:character}});
  expect(db().prepare('SELECT * FROM pixiv_character_checks WHERE image_id=?').get(id)).toBeUndefined();
  await ds.bulkImages({ids:[img('i27')],action:{type:'assign',characterId:character}});
  await ds.updateImage(img('i27'),{characterIds:[character]});
  expect(db().prepare('SELECT * FROM pixiv_character_checks WHERE image_id=?').get(id)).toBeUndefined();
  const removed=await ds.updateImage(img('i27'),{characterIds:[]});
  expect(db().prepare('SELECT result FROM pixiv_character_checks WHERE image_id=?').pluck().get(id)).toBe('dismissed');
  await ds.undo(removed.undoToken!);
  expect(db().prepare('SELECT * FROM pixiv_character_checks WHERE image_id=?').get(id)).toBeUndefined();
});
