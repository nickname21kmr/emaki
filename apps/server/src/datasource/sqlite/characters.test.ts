/**
 * T14 sqlite 专属：每个操作「执行 → 撤销」后 dumpCore 完全一致；合并留下重定向；自建角色匹配实时更新。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dumpCore } from '../../../test/helpers/dump.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import type { SqliteDataSource } from './SqliteDataSource.ts';
import { insertDanbooruCharacter } from './characters.ts';

let env: ContractEnv;
let ds: SqliteDataSource;
beforeEach(async () => {
  env = await sqliteFactory();
  ds = env.ds as SqliteDataSource;
});
afterEach(() => env.close());
const db = () => ds.ctx.db;
const c = (id: string) => env.id('character', id);

it('手动选图但没设焦点时自动裁切；明确设置的焦点保留，清空后重新推断', async () => {
  const id = c('c2');
  const coverImageId = env.id('image', 'i9');
  await ds.updateCharacter(id, { coverImageId, coverFocus: null });
  const automatic = (await ds.getCharacter(id))!.character;
  expect(automatic).toMatchObject({ coverImageId, coverManual: true, coverFocus: { space: 'image' } });
  await ds.updateCharacter(id, { coverFocus: { x: 0.1, y: 0.8 } });
  expect((await ds.getCharacter(id))!.character.coverFocus).toEqual({ x: 0.1, y: 0.8 });
  await ds.updateCharacter(id, { coverFocus: null });
  expect((await ds.getCharacter(id))!.character.coverFocus).toEqual(automatic.coverFocus);
});

describe('撤销后数据库完全还原', () => {
  const ops: [string, () => Promise<{ undoToken: string | null }>][] = [
    ['新建', () => ds.createCharacter({ name: '雪之下', workIds: [env.id('work', 'w3')], aliases: ['yukino'], danbooruTag: 'yukinoshita_yukino' })],
    ['修改全部字段', () => ds.updateCharacter(c('c2'), { name: '新名字', aliases: ['a', 'b'], workIds: [env.id('work', 'w2')], pinned: true, coverImageId: env.id('image', 'i9'), coverFocus: { x: 0.1, y: 0.2 }, danbooruTag: 'new_tag' })],
    ['合并（目标无标签）', () => ds.mergeCharacter(c('c1'), c('c7'))],
    ['合并（两边都有标签）', () => ds.mergeCharacter(c('c1'), c('c3'))],
  ];
  it.each(ops)('%s', async (_name, op) => {
    const before = dumpCore(db());
    const r = await op();
    expect(dumpCore(db())).not.toEqual(before);
    await ds.undo(r.undoToken!);
    expect(dumpCore(db())).toEqual(before);
  });
});

it('合并带标签的角色进另一个有标签的角色：旧标签重定向到目标', async () => {
  await ds.mergeCharacter(c('c1'), c('c3'));
  expect(ds.makeCatalog().catalog.resolveCharacterId('mika_(blue_archive)')).toBe(Number(c('c3')));
});

it('insertDanbooruCharacter 新建了作品时，撤销后作品和别名都不在了', async () => {
  const before = dumpCore(db());
  const r = ds.ctx.mutate((u) => {
    insertDanbooruCharacter(u, ds.makeCatalog().catalog, 'power_(chainsaw_man)', { now: '2026-01-01T00:00:00.000Z' });
    return { message: 'x' };
  });
  expect(db().prepare("SELECT count(*) FROM works WHERE danbooru_tag = 'chainsaw_man'").pluck().get()).toBe(1);
  await ds.undo(r.undoToken!);
  expect(dumpCore(db())).toEqual(before);
  expect(db().prepare("SELECT count(*) FROM aliases WHERE owner_type = 'work'").pluck().get()).toBe(
    before.aliases!.filter((a) => (a as { owner_type: string }).owner_type === 'work').length,
  );
});

it('自建角色能对上 Danbooru：stats 实时更新', async () => {
  db().exec(`INSERT INTO tag_i18n (tag, category, zh, aliases, copyright_guess, post_count) VALUES ('mika_(blue_archive)', 4, NULL, '[]', 'blue_archive', 16024);
    INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES ('mika', 'mika_(blue_archive)', 'tag', 'dict');`);
  // 夹具里 mika_(blue_archive) 已属于 c1：匹配照样成立（existing_character_id 指向 c1，前端会提示合并）
  const r = await ds.createCharacter({ name: 'Mika', workIds: [env.id('work', 'w1')] });
  expect((await ds.getStats()).customMatchableCount).toBe(1);
  await ds.updateCharacter(r.character.id, { workIds: [env.id('work', 'w2')] });
  expect((await ds.getStats()).customMatchableCount).toBe(0);
});

it('合并角色：合集的整本关联跟着搬，撤销后恢复（T38b，RV-C-6）', async () => {
  const now = '2026-09-27T00:00:00.000Z';
  const cid = Number(
    db()
      .prepare(`INSERT INTO collections (root_id, rel_dir, kind, kind_source, origin, created_at, updated_at)
        VALUES ((SELECT MIN(id) FROM library_roots), 'Book', 'doujin', 'manual', 'manual', ?, ?)`)
      .run(now, now).lastInsertRowid,
  );
  db().prepare('INSERT INTO collection_characters (collection_id, character_id, added_at) VALUES (?, ?, ?)').run(cid, Number(c('c7')), now);
  const linked = () => db().prepare('SELECT character_id FROM collection_characters WHERE collection_id = ?').pluck().all(cid);
  const r = await ds.mergeCharacter(c('c7'), c('c1'));
  expect(linked()).toEqual([Number(c('c1'))]);
  await ds.undo(r.undoToken!);
  expect(linked()).toEqual([Number(c('c7'))]);
});

it('撤销合并只回退合并搬过去的：合并之后识别器给目标新加的关联、别名留着', async () => {
  const to = Number(c('c1'));
  const img = Number(env.id('image', 'i24'));
  const before = dumpCore(db());
  const r = await ds.mergeCharacter(c('c7'), c('c1'));
  // 合并之后识别器把另一张图归给目标，词典给目标加了别名
  db().prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.9, 'x')").run(img, to);
  db().prepare("INSERT INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('character', ?, 'later', 'later', 'dict', 0, 9)").run(to);
  await ds.undo(r.undoToken!);
  expect(db().prepare('SELECT origin FROM image_characters WHERE image_id = ? AND character_id = ?').pluck().get(img, to)).toBe('tagger');
  expect(db().prepare("SELECT 1 FROM aliases WHERE owner_type = 'character' AND owner_id = ? AND alias = 'later'").get(to)).toBeTruthy();
  // 去掉之后加的两行，其余和合并前完全一样
  db().prepare('DELETE FROM image_characters WHERE image_id = ? AND character_id = ?').run(img, to);
  db().prepare("DELETE FROM aliases WHERE owner_type = 'character' AND owner_id = ? AND alias = 'later'").run(to);
  expect(dumpCore(db())).toEqual(before);
});

it('撤销合并时被合并角色的编号已经给了新角色：拒绝撤销，新角色和它的图都不动', async () => {
  // 新建的角色 id 最大，合并删掉后识别器新建角色会拿到同一个 id
  const made = await ds.createCharacter({ name: '临时', workIds: [] });
  const fromId = Number(made.character.id);
  db().prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'manual', 'x')").run(Number(env.id('image', 'i24')), fromId);
  const r = await ds.mergeCharacter(made.character.id, c('c1'));
  const g = ds.makeCatalog().catalog.ensureCharacter('test_girl_(emaki_test)', '2026-01-01T00:00:00.000Z');
  expect(g).toMatchObject({ id: fromId, created: true });
  db().prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.9, 'x')").run(Number(env.id('image', 'i25')), fromId);
  const snap = dumpCore(db());
  await expect(ds.undo(r.undoToken!)).rejects.toMatchObject({ statusCode: 409, message: '无法撤销：「临时」原来的编号已经给了之后新建的角色' });
  expect(dumpCore(db())).toEqual(snap);
});

describe('新建的角色被合并掉、编号又给了新角色：撤销更早的「新建」也要拒绝，不能删掉新角色', () => {
  /** 合并删掉 fromId 后识别器新建角色，拿到同一个编号，还归了一张图 */
  const reuse = async (fromId: number) => {
    await ds.mergeCharacter(String(fromId), c('c1'));
    const g = ds.makeCatalog().catalog.ensureCharacter('test_girl_(emaki_test)', '2026-10-01T00:00:00.000Z');
    expect(g).toMatchObject({ id: fromId, created: true });
    db().prepare("INSERT INTO image_characters (image_id, character_id, origin, score, added_at) VALUES (?, ?, 'tagger', 0.9, 'x')").run(Number(env.id('image', 'i25')), fromId);
  };

  it('createCharacter', async () => {
    const made = await ds.createCharacter({ name: '临时', workIds: [] });
    await reuse(Number(made.character.id));
    const snap = dumpCore(db());
    await expect(ds.undo(made.undoToken!)).rejects.toMatchObject({ statusCode: 409, message: '无法撤销：「临时」已经合并掉了，原来的编号给了之后新建的角色' });
    expect(dumpCore(db())).toEqual(snap);
  });

  it('insertDanbooruCharacter（接受建议、改类型时新建的角色）', async () => {
    let id = 0;
    const r = ds.ctx.mutate((u) => {
      id = insertDanbooruCharacter(u, ds.makeCatalog().catalog, 'power_(chainsaw_man)', { now: '2026-01-01T00:00:00.000Z' }).id;
      return { message: 'x' };
    });
    await reuse(id);
    const snap = dumpCore(db());
    await expect(ds.undo(r.undoToken!)).rejects.toMatchObject({ statusCode: 409, message: '无法撤销：新建的角色 power_(chainsaw_man) 已经合并掉了，原来的编号给了之后新建的角色' });
    expect(dumpCore(db())).toEqual(snap);
  });

  it('编号没被拿走时照常撤销（角色已经不在，什么也不删）', async () => {
    const made = await ds.createCharacter({ name: '临时', workIds: [] });
    await ds.mergeCharacter(made.character.id, c('c1'));
    const snap = dumpCore(db());
    await ds.undo(made.undoToken!);
    expect(dumpCore(db())).toEqual(snap);
  });
});
