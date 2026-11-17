/**
 * 附录 #37（编目）的关闭测试（P3b，docs/core-architecture.md 第 2.4、3.1 节）。
 *
 * #37 说的五件事，每件一组：
 * 1. 「标签 → 角色」只有一个解析（CharacterCatalog.resolveCharacterId）；
 * 2. 标签规范化只有一个入口（角色 normalizeTag、作品 normalizeWorkTag），撞上已有角色都走用户手动合并同一个函数；
 * 3. 整理名字看 name_locked，不再拿「名字等于自动起的名字」判断；
 * 4. 合并 / 收拢留下的旧名字记成 auto，不再是 user，不会把自动别名都藏起来（迁移 036 改旧数据，见 db/catalogOrigins.migration.test.ts）；
 * 5. 解绑 Danbooru 之后都是自建（custom），手动绑定和自动绑定一样按 Danbooru 补作品。
 *
 * 用的是真实的 SqliteDataSource（内存库）：启动修补（收拢）照常跑，seed 里的数据在收拢之前灌进去。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EventBus } from '../../src/core/events.ts';
import type { Db } from '../../src/db/connection.ts';
import { SqliteDataSource } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { DanbooruCatalog } from '../../src/services/danbooru/catalog.ts';
import { dumpCore } from '../helpers/dump.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { listSourceFiles } from './sqlWrites.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const T = '2026-01-01T00:00:00.000Z';
const SRC = path.resolve(import.meta.dirname, '../../src');

const opened: { ds: SqliteDataSource; dir: string }[] = [];
afterEach(async () => {
  for (const { ds, dir } of opened.splice(0)) {
    await ds.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一个全新的引擎：内存库、固定时钟、不跑后台任务。seed 在迁移之后、启动修补（收拢、自动关联）之前执行 */
async function engine(seed?: (db: Db) => void): Promise<SqliteDataSource> {
  const dir = makeTmpDir('catalog-closure');
  const ds = await SqliteDataSource.open(new EventBus(), path.join(dir, 'data'), {
    memory: true,
    clock: () => NOW,
    autoJobs: false,
    importDict: false,
    checkRecyclable: async () => {},
    trashImpl: async () => {},
    seed: (db) => {
      db.prepare("INSERT INTO library_roots (id, path, last_scan_at) VALUES (1, '//emaki-test/catalog', ?)").run(T);
      seed?.(db);
    },
  });
  opened.push({ ds, dir });
  return ds;
}

const insChar = (db: Db, name: string, tag: string | null, extra: { nameLocked?: boolean } = {}) =>
  Number(
    db
      .prepare('INSERT INTO characters (name, danbooru_tag, source, name_locked, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, tag, tag ? 'danbooru' : 'custom', extra.nameLocked ? 1 : 0, T).lastInsertRowid,
  );
const insImage = (db: Db, id: number) =>
  db
    .prepare(
      "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, ?, ?)",
    )
    .run(id, `${id}.png`, `${id}.png`, `s${id}`, T, T);
const linkManual = (db: Db, imageId: number, characterId: number) =>
  db.prepare("INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, ?, 'manual', 'user', ?)").run(imageId, characterId, T);
/** 词库里登记成角色（服装变体归本体要求本体是已知角色） */
const knownCharacter = (db: Db, tag: string) =>
  db.prepare("INSERT OR IGNORE INTO tag_i18n (tag, category, aliases) VALUES (?, 4, '[]')").run(tag);
const rename = (db: Db, from: string, to: string) =>
  db.prepare("INSERT OR REPLACE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'danbooru')").run(from, to);
const verifiedForm = (db: Db, tag: string, base: string) =>
  db
    .prepare("INSERT INTO character_verified_forms (tag, character_tag, relation, aliases, sources, evidence) VALUES (?, ?, 'same-character', '[]', '[]', 'x')")
    .run(tag, base);

const charRow = (ds: SqliteDataSource, id: number) =>
  ds.ctx.db.prepare('SELECT id, name, danbooru_tag AS tag, source FROM characters WHERE id = ?').get(id) as
    | { id: number; name: string; tag: string | null; source: string }
    | undefined;
const aliasRows = (ds: SqliteDataSource, owner: 'character' | 'work', id: number) =>
  ds.ctx.db
    .prepare('SELECT alias, origin, visible FROM aliases WHERE owner_type = ? AND owner_id = ? ORDER BY position, alias')
    .all(owner, id) as { alias: string; origin: string; visible: number }[];

/** 跑一次「同步 Danbooru」（联网关闭：只落库），等它结束 */
async function syncDanbooru(ds: SqliteDataSource): Promise<void> {
  const job = ds.ctx.jobs.enqueue('danbooru-sync');
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled'], JSON.stringify(ds.ctx.jobs.list())).toContain(job.status));
  expect(job.status, job.message).toBe('done');
}

/** 源码（不含测试）里匹配 re 的文件，相对 src */
function sourcesMatching(re: RegExp): string[] {
  return listSourceFiles(SRC)
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
}

describe('#37-1 「标签 → 角色」只有一个解析', () => {
  it('按标签找角色（角色自己的标签 + 合并重定向）的查询只在 CharacterCatalog 里', () => {
    expect(sourcesMatching(/danbooru_tag_redirects(\s+\w+)?\s+WHERE\s+(\w+\.)?tag\s*=/)).toEqual(['domain/catalog/characterCatalog.ts']);
    expect(sourcesMatching(/resolveCharacterIdByTag|findByTag/)).toEqual([]);
  });

  it('自建角色匹配记下的「已有角色」认合并重定向（以前只认角色自己的标签）', async () => {
    const ds = await engine((db) => {
      knownCharacter(db, 'nia_liston');
      db.prepare("INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES ('にありすとん', 'nia_liston', 'other_name', 'danbooru')").run();
    });
    const db = ds.ctx.db;
    // 别的角色经合并重定向占着这个标签
    const owner = insChar(db, '已有倪亚', 'nia_liston_(old)');
    db.prepare("INSERT INTO danbooru_tag_redirects (tag, character_id) VALUES ('nia_liston', ?)").run(owner);
    const made = await ds.createCharacter({ name: '倪亚', aliases: ['ニア・リストン'], workIds: [] });
    // 标签已经有主人：不自动绑，留给用户合并；记下的已有角色就是解析出来的那个
    expect(made.character).toMatchObject({ source: 'custom', danbooruTag: null });
    expect(db.prepare('SELECT existing_character_id FROM custom_character_matches WHERE character_id = ?').pluck().get(Number(made.character.id))).toBe(owner);
    expect(await ds.listCustomCharacterMatches()).toMatchObject([{ existingCharacterId: String(owner) }]);
  });

  it('收拢判断撞车用同一个解析：核验过的形态、本体还没有角色时，解析就落在这个角色上，不改它的标签', async () => {
    let p = 0;
    const ds = await engine((db) => {
      verifiedForm(db, 'ai_(idol)', 'hoshino_ai');
      p = insChar(db, '小爱', 'ai_(idol)');
    });
    expect(charRow(ds, p)).toMatchObject({ name: '小爱', tag: 'ai_(idol)' });
    expect(ds.makeCatalog().catalog.resolveCharacterId('hoshino_ai')).toBe(p);
  });
});

describe('#37-2 标签规范化只有一个入口，撞上已有角色都合并', () => {
  it('启动收拢用的就是解析时的规范化：核验过的身份撞上已有角色，也合并（以前收拢不看核验）', async () => {
    let p = 0;
    let q = 0;
    const ds = await engine((db) => {
      verifiedForm(db, 'ai_(idol)', 'hoshino_ai');
      p = insChar(db, '小爱', 'ai_(idol)');
      q = insChar(db, '星野爱', 'hoshino_ai');
      insImage(db, 1);
      linkManual(db, 1, p);
    });
    const db = ds.ctx.db;
    expect(charRow(ds, p)).toBeUndefined();
    expect(db.prepare('SELECT character_id FROM image_characters WHERE image_id = 1').pluck().all()).toEqual([q]);
    expect(db.prepare("SELECT character_id FROM danbooru_tag_redirects WHERE tag = 'ai_(idol)'").pluck().get()).toBe(q);
  });

  it('Danbooru 同步落库时改名撞上已有角色：和启动收拢一样合并过去（以前只记日志，两个角色一直拆着）', async () => {
    let a = 0;
    let b = 0;
    const ds = await engine((db) => {
      a = insChar(db, '五条（旧标签）', 'gojou_satoru');
      b = insChar(db, '五条悟', 'gojo_satoru');
      insImage(db, 1);
      linkManual(db, 1, a);
    });
    const db = ds.ctx.db;
    // 启动时还不知道改名，两个角色都在
    expect(charRow(ds, a)).toBeDefined();
    // 同步 Danbooru 记下了改名（DanbooruCatalog.markAlias）
    ds.danbooru.markAlias('gojou_satoru', 'gojo_satoru', new Date(NOW).toISOString());
    await syncDanbooru(ds);
    expect(charRow(ds, a)).toBeUndefined();
    expect(db.prepare('SELECT character_id FROM image_characters WHERE image_id = 1').pluck().all()).toEqual([b]);
    expect(db.prepare("SELECT character_id FROM danbooru_tag_redirects WHERE tag = 'gojou_satoru'").pluck().get()).toBe(b);
    expect(aliasRows(ds, 'character', b).map((r) => r.alias)).toContain('五条（旧标签）');
  });

  it('合并不了的（被合并的角色有排除规则）记日志跳过，不中断收拢', async () => {
    let a = 0;
    let c = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ds = await engine((db) => {
      a = insChar(db, '五条（旧标签）', 'gojou_satoru');
      insChar(db, '五条悟', 'gojo_satoru');
      c = insChar(db, '凑阿库娅（初始服装）', 'minato_aqua_(1st_costume)');
      knownCharacter(db, 'minato_aqua');
      rename(db, 'gojou_satoru', 'gojo_satoru');
      db.prepare("INSERT INTO exclusions (kind, target, label, created_at) VALUES ('character', ?, '五条', ?)").run(String(a), T);
    });
    expect(charRow(ds, a)).toMatchObject({ tag: 'gojou_satoru' });
    expect(log.mock.calls.flat().join('\n')).toContain('没有合并「五条（旧标签）」');
    // 后面的照常收拢：服装变体改成本体的标签
    expect(charRow(ds, c)).toMatchObject({ tag: 'minato_aqua' });
    log.mockRestore();
  });

  it('作品只按改名表规范化，建作品和收拢作品走同一个入口：旧名不会再建出第二部', async () => {
    let w = 0;
    const ds = await engine((db) => {
      rename(db, 'alice_in_wonderland', "alice's_adventures_in_wonderland");
      w = Number(db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES ('爱丽丝', 'alice_in_wonderland', ?)").run(T).lastInsertRowid);
    });
    const catalog = ds.makeCatalog().catalog;
    expect(catalog.normalizeWorkTag('alice_in_wonderland')).toBe("alice's_adventures_in_wonderland");
    expect(ds.ctx.db.prepare('SELECT danbooru_tag FROM works WHERE id = ?').pluck().get(w)).toBe("alice's_adventures_in_wonderland");
    expect(catalog.ensureWork('alice_in_wonderland', T)).toEqual({ id: w, created: false });
  });

  it('只按 Danbooru 规则（不看核验）的那一步不再对外：调用方只能用 normalizeTag', () => {
    expect(sourcesMatching(/normalizeDanbooruTag/)).toEqual([]);
    expect(sourcesMatching(/\.danbooruBase\(/)).toEqual(['services/danbooru/catalog.ts']);
    expect(Object.getOwnPropertyNames(DanbooruCatalog.prototype)).toEqual(expect.arrayContaining(['normalizeTag', 'canonicalize']));
  });
});

describe('#37-3 整理名字看 name_locked', () => {
  it('收拢改标签：名字没锁定的跟着换（哪怕已经不是当初自动起的名字），锁定的不动（哪怕和自动名字一样）', async () => {
    let free = 0;
    let locked = 0;
    const ds = await engine((db) => {
      rename(db, 'old_girl', 'new_girl');
      rename(db, 'old_boy', 'new_boy');
      // 自动起的名字后来被同名消歧改过（relocalize 加了后缀），但用户没改过
      free = insChar(db, 'Old Girl（旧）', 'old_girl');
      // 用户改过名字，恰好和自动起的一样
      locked = insChar(db, 'Old Boy', 'old_boy', { nameLocked: true });
    });
    expect(charRow(ds, free)).toMatchObject({ tag: 'new_girl', name: 'New Girl' });
    expect(aliasRows(ds, 'character', free).find((r) => r.alias === 'Old Girl（旧）')).toBeDefined();
    expect(charRow(ds, locked)).toMatchObject({ tag: 'new_boy', name: 'Old Boy' });
  });

  it('作品同理看 works.name_locked', async () => {
    let free = 0;
    let locked = 0;
    const ds = await engine((db) => {
      rename(db, 'old_show', 'new_show');
      rename(db, 'old_game', 'new_game');
      const ins = db.prepare('INSERT INTO works (name, danbooru_tag, name_locked, created_at) VALUES (?, ?, ?, ?)');
      free = Number(ins.run('旧节目（第二季）', 'old_show', 0, T).lastInsertRowid);
      locked = Number(ins.run('Old Game', 'old_game', 1, T).lastInsertRowid);
    });
    const work = (id: number) => ds.ctx.db.prepare('SELECT name, danbooru_tag AS tag FROM works WHERE id = ?').get(id);
    expect(work(free)).toEqual({ name: 'New Show', tag: 'new_show' });
    expect(work(locked)).toEqual({ name: 'Old Game', tag: 'new_game' });
  });
});

describe('#37-4 合并 / 收拢留下的旧名字记成 auto，不再把自动别名都藏起来', () => {
  const MIKA = 'mika_(blue_archive)';
  /** 目标角色：按词库建（自动别名里「Mika」是显示的），再把一个自建角色合并进来 */
  async function mergedPair() {
    const ds = await engine((db) => db.prepare("INSERT INTO tag_i18n (tag, category, zh, aliases) VALUES (?, 4, '圣园未花', '[]')").run(MIKA));
    const db = ds.ctx.db;
    const to = ds.makeCatalog().catalog.ensureCharacter(MIKA, T).id;
    const from = insChar(db, '未花（自建）', null);
    expect(aliasRows(ds, 'character', to)).toContainEqual({ alias: 'Mika', origin: 'dict', visible: 1 });
    await ds.mergeCharacter(String(from), String(to));
    return { ds, to };
  }

  it('合并：被合并角色的名字记 auto；刷新自动别名（Danbooru 同步落库）后它还在，词库别名照样显示', async () => {
    const { ds, to } = await mergedPair();
    expect(aliasRows(ds, 'character', to)).toContainEqual({ alias: '未花（自建）', origin: 'auto', visible: 1 });
    await syncDanbooru(ds);
    const rows = aliasRows(ds, 'character', to);
    expect(rows).toContainEqual({ alias: '未花（自建）', origin: 'auto', visible: 1 });
    expect(rows).toContainEqual({ alias: 'Mika', origin: 'dict', visible: 1 });
    expect((await ds.getCharacter(String(to)))!.character.aliases).toEqual(expect.arrayContaining(['未花（自建）', 'Mika']));
  });

  it('用户真的整理过别名才藏自动别名：机器留下的名字也跟着改成只供搜索，但不会被刷新删掉', async () => {
    const { ds, to } = await mergedPair();
    await ds.updateCharacter(String(to), { aliases: ['小未花'] });
    await syncDanbooru(ds);
    const rows = aliasRows(ds, 'character', to);
    expect(rows).toContainEqual({ alias: '小未花', origin: 'user', visible: 1 });
    expect(rows).toContainEqual({ alias: 'Mika', origin: 'dict', visible: 0 });
    expect(rows).toContainEqual({ alias: '未花（自建）', origin: 'auto', visible: 0 });
  });

  it('收拢改标签：原来的名字记 auto', async () => {
    let id = 0;
    const ds = await engine((db) => {
      rename(db, 'old_girl', 'new_girl');
      id = insChar(db, '旧名字', 'old_girl');
    });
    expect(aliasRows(ds, 'character', id)).toContainEqual({ alias: '旧名字', origin: 'auto', visible: 1 });
  });

  it('写 user 别名的只有用户编辑别名一处', () => {
    expect(sourcesMatching(/'user', 1, \?\)|'user', 1, 50\)/)).toEqual(['domain/catalog/aliases.ts']);
    const src = readFileSync(path.join(SRC, 'domain/catalog/aliases.ts'), 'utf8');
    expect(src.match(/'user', 1, /g)).toHaveLength(1);
  });
});

describe('#37-5 解绑之后都是自建；手动绑定和自动绑定一样补作品', () => {
  const NIA = 'nia_liston';
  const NIA_WORK = 'kyouran_reijou_nia_liston';
  /** 词库：nia_liston 是角色，作品猜 kyouran_reijou_nia_liston；日文名能对上 */
  const niaDict = (db: Db) => {
    db.prepare("INSERT INTO tag_i18n (tag, category, aliases, copyright_guess, post_count) VALUES (?, 4, '[]', ?, 11)").run(NIA, NIA_WORK);
    db.prepare("INSERT INTO tag_name_keys (search_key, tag, kind, source) VALUES ('にありすとん', ?, 'other_name', 'danbooru')").run(NIA);
  };
  const workTags = (ds: SqliteDataSource, id: number) =>
    ds.ctx.db
      .prepare('SELECT w.danbooru_tag FROM character_works cw JOIN works w ON w.id = cw.work_id WHERE cw.character_id = ? ORDER BY cw.position')
      .pluck()
      .all(id);
  const match = (ds: SqliteDataSource, id: number) =>
    ds.ctx.db.prepare('SELECT danbooru_tag AS tag, dismissed FROM custom_character_matches WHERE character_id = ?').get(id);

  it('手动解绑：改回自建、忽略这个标签，之后的自动关联不会再绑回去；撤销恢复绑定', async () => {
    const ds = await engine(niaDict);
    const made = await ds.createCharacter({ name: '倪亚', aliases: ['ニア・リストン'], workIds: [] });
    const id = Number(made.character.id);
    expect(charRow(ds, id)).toMatchObject({ tag: NIA, source: 'danbooru' });
    const r = await ds.updateCharacter(made.character.id, { danbooruTag: null });
    expect(charRow(ds, id)).toMatchObject({ tag: null, source: 'custom' });
    expect(match(ds, id)).toEqual({ tag: NIA, dismissed: 1 });
    // 同步落库之后会跑一遍自动关联：不会把用户解掉的标签绑回去，也不出现在待确认的匹配里
    await syncDanbooru(ds);
    expect(charRow(ds, id)).toMatchObject({ tag: null, source: 'custom' });
    expect(await ds.listCustomCharacterMatches()).toEqual([]);
    await ds.undo(r.undoToken!);
    expect(charRow(ds, id)).toMatchObject({ tag: NIA, source: 'danbooru' });
  });

  it('手动解绑和撤回自动绑定的结果一样（都是自建 + 忽略这个标签）', async () => {
    const ds = await engine();
    const db = ds.ctx.db;
    // 先建自建角色，之后词库才有它的名字：后台自动关联会记一条可撤回的改动
    const auto = Number((await ds.createCharacter({ name: '倪亚', aliases: ['ニア・リストン'], workIds: [] })).character.id);
    niaDict(db);
    await syncDanbooru(ds);
    expect(charRow(ds, auto)).toMatchObject({ tag: NIA, source: 'danbooru' });
    const [entry] = await ds.listChanges('auto');
    await ds.revertChange(entry!.id);
    // 另一个角色手动绑定再手动解绑
    const manual = Number((await ds.createCharacter({ name: '另一个', workIds: [] })).character.id);
    await ds.updateCharacter(String(manual), { danbooruTag: NIA });
    await ds.updateCharacter(String(manual), { danbooruTag: null });
    for (const id of [auto, manual]) {
      expect(charRow(ds, id)).toMatchObject({ tag: null, source: 'custom' });
      // 名字对不上任何标签（「另一个」）时，忽略记录也留着
      expect(match(ds, id)).toEqual({ tag: NIA, dismissed: 1 });
    }
  });

  it('手动绑定和自动绑定一样：没手动指定作品就按 Danbooru 补作品，撤销连新建的作品一起还原；一起指定了作品就不补', async () => {
    const ds = await engine(niaDict);
    const db = ds.ctx.db;
    // 编辑时绑定
    const plain = await ds.createCharacter({ name: '甲', workIds: [] });
    const before = dumpCore(db);
    const r = await ds.updateCharacter(plain.character.id, { danbooruTag: NIA });
    expect(workTags(ds, Number(plain.character.id))).toEqual([NIA_WORK]);
    await ds.undo(r.undoToken!);
    expect(dumpCore(db)).toEqual(before);
    // 新建时就给标签
    const made = await ds.createCharacter({ name: '乙', danbooruTag: NIA, workIds: [] });
    expect(workTags(ds, Number(made.character.id))).toEqual([NIA_WORK]);
    await ds.undo(made.undoToken!);
    expect(dumpCore(db)).toEqual(before);
    // 一起指定了作品：用户的选择优先
    const own = Number(db.prepare("INSERT INTO works (name, created_at) VALUES ('我的作品', ?)").run(T).lastInsertRowid);
    const locked = await ds.createCharacter({ name: '丙', danbooruTag: NIA, workIds: [String(own)] });
    expect(workTags(ds, Number(locked.character.id))).toEqual([null]);
    // 自动绑定（新建时按日文名对上）补的也是同一部
    await ds.undo(locked.undoToken!);
    const auto = await ds.createCharacter({ name: '丁', aliases: ['ニア・リストン'], workIds: [] });
    expect(auto.character).toMatchObject({ danbooruTag: NIA, source: 'danbooru' });
    expect(workTags(ds, Number(auto.character.id))).toEqual([NIA_WORK]);
  });
});
