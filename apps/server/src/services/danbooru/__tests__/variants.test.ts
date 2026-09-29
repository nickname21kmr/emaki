import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { consolidateCharacterTags, consolidateWorkTags } from '../../../datasource/sqlite/consolidate.ts';
import { CopyrightResolver } from '../../catalog/copyrights.ts';
import { HumanizeLocalizer } from '../../i18n/localizer.ts';
import { DanbooruCatalog, sameLineage } from '../catalog.ts';

// 换 PixAI 之后的角色归并（2026-09-28）：服装变体归本体、模型之间的改名、已经拆开的角色收拢
let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  const i18n = db.prepare("INSERT INTO tag_i18n (tag, category, zh, post_count) VALUES (?, ?, ?, 100)");
  for (const t of ['minato_aqua', 'yuudachi_(kancolle)', 'artoria_pendragon_(fate)', 'hoshino_ai']) i18n.run(t, 4, t);
  i18n.run('oshi_no_ko', 3, '我推的孩子');
  // implication：夕立改二 ⊃ 夕立；Saber Alter ⊃ 阿尔托莉雅（名字不同，不该归并）
  const tag = db.prepare("INSERT INTO danbooru_tags (name, category, fetched_at, implies) VALUES (?, 4, '2026-09-28', ?)");
  tag.run('yuudachi_kai_ni_(kancolle)', JSON.stringify(['yuudachi_(kancolle)']));
  tag.run('yuudachi_(kancolle)', '[]');
  tag.run('saber_alter', JSON.stringify(['artoria_pendragon_(fate)']));
  tag.run('artoria_pendragon_(fate)', '[]');
});
const catalog = () => new DanbooruCatalog(db, new CopyrightResolver(db, {}));

describe('sameLineage', () => {
  it('本体名字连续出现在变体名字里才算', () => {
    expect(sameLineage('yuudachi_kai_ni_(kancolle)', 'yuudachi_(kancolle)')).toBe(true);
    expect(sameLineage('male_doctor_(arknights)', 'doctor_(arknights)')).toBe(true);
    expect(sameLineage('saber_alter', 'artoria_pendragon_(fate)')).toBe(false);
    expect(sameLineage('scathach-skadi_(fate)', 'scathach_(fate)')).toBe(false);
  });
});

describe('normalizeTag', () => {
  it('单层括号的服装变体归本体；括号里是作品名的不动', () => {
    const c = catalog();
    expect(c.normalizeTag('minato_aqua_(1st_costume)')).toBe('minato_aqua');
    expect(c.normalizeTag('hoshino_ai_(oshi_no_ko)')).toBe('hoshino_ai'); // 迁移 009 的改名
    expect(c.normalizeTag('unknown_girl_(1st_costume)')).toBe('unknown_girl_(1st_costume)'); // 本体不认识：不动
  });
  it('幂等：规范化过的标签再规范化一次不变（否则建角色时会重复 INSERT）', () => {
    const c = catalog();
    for (const t of ['minato_aqua_(1st_costume)', 'hoshino_ai_(oshi_no_ko)', 'yuudachi_kai_ni_(kancolle)', 'saber_alter']) {
      const once = c.normalizeTag(t);
      expect(c.normalizeTag(once)).toBe(once);
    }
  });

  it('implication 只在名字同源时归并', () => {
    const c = catalog();
    expect(c.normalizeTag('yuudachi_kai_ni_(kancolle)')).toBe('yuudachi_(kancolle)');
    expect(c.normalizeTag('saber_alter')).toBe('saber_alter');
  });
});

describe('consolidateCharacterTags', () => {
  it('本体有角色就合并过去，没有就改标签；再跑一次什么也不做', () => {
    const ins = db.prepare("INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES (?, ?, 'danbooru', '2026-09-28')");
    const base = Number(ins.run('凑阿库娅', 'minato_aqua').lastInsertRowid);
    const variant = Number(ins.run('凑阿库娅（初始服装）', 'minato_aqua_(1st_costume)').lastInsertRowid);
    const renamedId = Number(ins.run('Hoshino Ai', 'hoshino_ai_(oshi_no_ko)').lastInsertRowid);
    const merges: [number, number][] = [];
    const c = catalog();
    const deps = {
      normalizeTag: (t: string) => c.normalizeTag(t),
      localizer: new HumanizeLocalizer(),
      merge: (from: number, to: number) => {
        merges.push([from, to]);
        db.prepare('DELETE FROM characters WHERE id = ?').run(from);
      },
    };
    expect(consolidateCharacterTags(db, deps)).toEqual({ merged: 1, renamed: 1 });
    expect(merges).toEqual([[variant, base]]);
    expect(db.prepare('SELECT danbooru_tag FROM characters WHERE id = ?').pluck().get(renamedId)).toBe('hoshino_ai');
    // 旧写法留一条重定向：以后再碰到旧写法也落到这个角色
    expect(db.prepare('SELECT character_id FROM danbooru_tag_redirects WHERE tag = ?').pluck().get('hoshino_ai_(oshi_no_ko)')).toBe(renamedId);
    expect(consolidateCharacterTags(db, deps)).toEqual({ merged: 0, renamed: 0 });
  });
});

describe('consolidateWorkTags', () => {
  const OLD = 'alice_in_wonderland';
  const NEW = "alice's_adventures_in_wonderland";
  beforeEach(() => {
    const rename = db.prepare("INSERT INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'danbooru')");
    rename.run(OLD, NEW);
    rename.run('yuru_yuri', 'yuruyuri');
  });

  it('改过名的作品：新名已有就并过去（图、手动别名搬走，旧的删掉），没有就改名；再跑一次什么也不做', () => {
    const work = db.prepare("INSERT INTO works (name, danbooru_tag, created_at) VALUES (?, ?, '2026-09-28')");
    const oldId = Number(work.run('爱丽丝梦游仙境', OLD).lastInsertRowid);
    const newId = Number(work.run('爱丽丝梦游仙境', NEW).lastInsertRowid);
    const lonely = Number(work.run('Yuru Yuri', 'yuru_yuri').lastInsertRowid);
    db.prepare("INSERT INTO library_roots (id, path) VALUES (1, 'D:/lib')").run();
    const img = db.prepare(
      "INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at) VALUES (?, 1, ?, ?, 1, 1, 1, 'png', ?, 'x', 'x')",
    );
    img.run(1, '1.png', '1.png', 's1');
    img.run(2, '2.png', '2.png', 's2');
    const ic = db.prepare('INSERT INTO image_copyrights (image_id, work_id, score) VALUES (?, ?, ?)');
    ic.run(1, oldId, 0.6);
    ic.run(2, oldId, 0.4);
    ic.run(2, newId, null); // 手动挂的：合并后仍是手动
    db.prepare(
      "INSERT INTO aliases (owner_type, owner_id, alias, search_key, origin, visible, position) VALUES ('work', ?, '梦游仙境', '梦游仙境', 'user', 1, 50)",
    ).run(oldId);

    const c = catalog();
    const deps = { canonicalize: (t: string) => c.canonicalize(t), localizer: new HumanizeLocalizer() };
    expect(consolidateWorkTags(db, deps)).toEqual({ merged: 1, renamed: 1 });
    expect(db.prepare('SELECT id FROM works WHERE id = ?').get(oldId)).toBeUndefined();
    expect(db.prepare('SELECT image_id, score FROM image_copyrights WHERE work_id = ? ORDER BY image_id').all(newId)).toEqual([
      { image_id: 1, score: 0.6 },
      { image_id: 2, score: null },
    ]);
    expect(db.prepare("SELECT alias FROM aliases WHERE owner_type = 'work' AND owner_id = ?").pluck().all(newId)).toContain('梦游仙境');
    expect(db.prepare('SELECT danbooru_tag FROM works WHERE id = ?').pluck().get(lonely)).toBe('yuruyuri');
    expect(consolidateWorkTags(db, deps)).toEqual({ merged: 0, renamed: 0 });
  });

  it('角色所属的作品按改名表换成新名，不会再按旧名建作品', () => {
    const c = new DanbooruCatalog(db, new CopyrightResolver(db, { 'alice_(alice_in_wonderland)': [OLD] }));
    expect(c.copyrights('alice_(alice_in_wonderland)')).toEqual([NEW]);
  });
});
