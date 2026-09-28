import { searchKey } from '@emaki/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { CopyrightResolver } from '../../catalog/copyrights.ts';
import { DanbooruCatalog } from '../../danbooru/catalog.ts';
import { importDictIfNeeded } from '../dict.ts';
import { cleanOtherName, stripZhQualifier } from '../humanize.ts';
import { SqliteLocalizer } from '../localizer.ts';
import { relocalizeAll } from '../relocalize.ts';
import { isNeutralHan, isSimplifiedZh } from '../script.ts';

let db: Db;
let danbooru: DanbooruCatalog;
const loc = () => new SqliteLocalizer(db, danbooru);
const fake = (name: string, others: string[]) =>
  db.prepare('INSERT INTO danbooru_tags (name, category, post_count, fetched_at, other_names) VALUES (?, 4, 10, ?, ?)').run(name, 'x', JSON.stringify(others));

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db);
  expect(importDictIfNeeded(db, undefined, () => {}).imported).toBe(true);
  danbooru = new DanbooruCatalog(db, CopyrightResolver.fromAsset(db));
});

describe('纯函数', () => {
  it('stripZhQualifier / cleanOtherName', () => {
    expect(stripZhQualifier('圣园未花（泳装）（蔚蓝档案）')).toBe('圣园未花（泳装）');
    expect(stripZhQualifier('（蔚蓝档案）')).toBe('（蔚蓝档案）');
    expect(cleanOtherName('Misono_Mika')).toBe('Misono Mika');
    expect(cleanOtherName('https://example.com')).toBeNull();
  });
  it.each([
    ['圣园未花', true],
    ['未花', false],
    ['聖園彌香', false],
    ['博麗霊夢', false],
  ])('isSimplifiedZh(%s) = %s', (s, want) => expect(isSimplifiedZh(s)).toBe(want));
  it('未花 是简繁同形', () => expect(isNeutralHan('未花')).toBe(true));
});

describe('SqliteLocalizer', () => {
  it('词库', () => {
    const l = loc();
    expect(l.characterName('mika_(blue_archive)')).toEqual({ name: '圣园未花', source: 'dict' });
    expect(l.characterName('mika_(swimsuit)_(blue_archive)').name).toBe('圣园未花（泳装）');
    expect(l.characterName('gojou_satoru').name).toBe('五条悟'); // 经旧名映射
    expect(l.workName('blue_archive').name).toBe('蔚蓝档案');
    expect(l.workName('fate_(series)').name).toBe('Fate系列');
  });

  it('wiki 其他名字：简体 → 转换 → 日文 → 标签', () => {
    fake('fake_mika_(emaki_test)', ['聖園ミカ', 'Misono_Mika', '圣园未花']);
    fake('fake_reimu_(emaki_test)', ['博麗霊夢', 'Hakurei_Reimu']);
    fake('fake_hoshino_(emaki_test)', ['ホシノ']);
    const l = loc();
    expect(l.characterName('fake_mika_(emaki_test)')).toEqual({ name: '圣园未花', source: 'wiki-zh' });
    expect(l.characterName('fake_reimu_(emaki_test)')).toEqual({ name: '博丽灵梦', source: 'wiki-converted' });
    expect(l.characterName('fake_hoshino_(emaki_test)')).toEqual({ name: 'ホシノ', source: 'wiki-ja' });
    expect(l.characterName('some_new_char_(foo_bar)')).toEqual({ name: 'Some New Char', source: 'tag' });
    expect(l.workName('fate/grand_order_test').name).toBe('Fate/Grand Order Test');
  });

  it('aliasesFor：无重复、不含显示名、可见 ≤ 4', () => {
    const l = loc();
    const list = l.aliasesFor('mika_(blue_archive)', 'character', '圣园未花');
    const keys = list.map((a) => searchKey(a.alias));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(searchKey('圣园未花'));
    expect(list.filter((a) => a.visible).length).toBeLessThanOrEqual(4);
    expect(list.filter((a) => a.visible).map((a) => a.alias)).toContain('未花');
  });
});

describe('relocalizeAll', () => {
  it('锁定的名字不变；同名角色消歧', () => {
    db.exec(`INSERT INTO characters (id, name, danbooru_tag, source, name_locked, created_at) VALUES
      (1, 'x', 'mika_(blue_archive)', 'danbooru', 0, 'x'),
      (2, '我改的名字', 'hina_(blue_archive)', 'danbooru', 1, 'x'),
      (3, 'x', 'saber_(fate)', 'danbooru', 0, 'x'),
      (4, 'x', 'artoria_pendragon_(fate)', 'danbooru', 0, 'x')`);
    db.transaction(() => relocalizeAll(db, loc()))();
    const name = (id: number) => db.prepare('SELECT name FROM characters WHERE id = ?').pluck().get(id);
    expect(name(1)).toBe('圣园未花');
    expect(name(2)).toBe('我改的名字');
    expect(name(3)).not.toBe(name(4));
  });

  it('第二次导入跳过', () => expect(importDictIfNeeded(db, undefined, () => {}).imported).toBe(false));
});
