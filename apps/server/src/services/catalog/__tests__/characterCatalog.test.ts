import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../db/connection.ts';
import { migrate } from '../../../db/migrate.ts';
import { CharacterCatalog } from '../characterCatalog.ts';

const noCopyrights = { copyrights: () => [] };

describe('CharacterCatalog.ensureCharacter', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  // 变体归本体后，本体在 Danbooru 上又改过名（改名信息是后来同步到的）：
  // mika_(swimsuit) → mika，mika → mika_new；库里已有早先建的 mika
  const normalizeTag = (t: string) => ({ 'mika_(swimsuit)': 'mika', mika: 'mika_new' })[t] ?? t;

  it('规范化不是一步到位时，找到已有的角色而不是重复插入', () => {
    const id = Number(
      db.prepare("INSERT INTO characters (name, danbooru_tag, source, created_at) VALUES ('Mika', 'mika', 'danbooru', 'x')").run().lastInsertRowid,
    );
    const catalog = new CharacterCatalog(db, { copyrights: noCopyrights, normalizeTag });
    expect(catalog.ensureCharacter('mika_(swimsuit)', 'now')).toMatchObject({ id, created: false });
    expect(catalog.ensureCharacter('mika', 'now')).toMatchObject({ id, created: false });
    expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(1);
  });

  it('都没有时照常新建，之后再遇到直接复用', () => {
    const catalog = new CharacterCatalog(db, { copyrights: noCopyrights, normalizeTag });
    const a = catalog.ensureCharacter('mika_(swimsuit)', 'now');
    expect(a.created).toBe(true);
    expect(catalog.ensureCharacter('mika_(swimsuit)', 'now')).toMatchObject({ id: a.id, created: false });
    expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(1);
  });
});
