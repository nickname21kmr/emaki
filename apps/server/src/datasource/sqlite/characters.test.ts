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
