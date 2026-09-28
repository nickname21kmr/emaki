import { beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { ConflictError } from '../../http/errors.ts';
import { dumpCore } from '../../../test/helpers/dump.ts';
import { UndoRecorder } from './undo.ts';

const T = '2026-01-01T00:00:00.000Z';

function setup(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  db.exec(`
    INSERT INTO library_roots (id, path) VALUES (1, 'D:/a');
    INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '作品', 'w', '${T}');
    INSERT INTO characters (id, name, danbooru_tag, source, created_at) VALUES (1, '甲', 'a', 'danbooru', '${T}'), (2, '乙', 'b', 'danbooru', '${T}');
    INSERT INTO character_works (character_id, work_id) VALUES (1, 1), (2, 1);
    INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
      VALUES (1, 1, 'x/1.png', '1.png', 10, 10, 1, 'png', 's1', '${T}', '${T}'),
             (2, 1, 'x/2.png', '2.png', 10, 10, 1, 'png', 's2', '${T}', '${T}');
    INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (1, 1, 'manual', '${T}'), (2, 2, 'manual', '${T}');
  `);
  return db;
}

/** 在一个事务里执行 fn（fn 负责记录撤销数据 + 真正修改），返回撤销函数 */
function act(db: Db, fn: (u: UndoRecorder) => void): () => Promise<void> {
  const u = new UndoRecorder(db);
  db.transaction(() => fn(u))();
  return u.build();
}

describe('UndoRecorder', () => {
  let db: Db;
  beforeEach(() => {
    db = setup();
  });

  it('插入新行 → 撤销删除', async () => {
    const before = dumpCore(db);
    const revert = act(db, (u) => {
      const id = Number(db.prepare("INSERT INTO characters (name, source, created_at) VALUES ('丙', 'custom', ?)").run(T).lastInsertRowid);
      u.inserted('characters', id);
    });
    expect(dumpCore(db)).not.toEqual(before);
    await revert();
    expect(dumpCore(db)).toEqual(before);
  });

  it('改列 → 撤销恢复旧值', async () => {
    const before = dumpCore(db);
    const revert = act(db, (u) => {
      u.columns('images', ['favorite', 'rating'], [1, 2]);
      db.prepare("UPDATE images SET favorite = 1, rating = 'explicit'").run();
    });
    await revert();
    expect(dumpCore(db)).toEqual(before);
  });

  it('删父行（带级联子行）→ 撤销后父子都回来', async () => {
    const before = dumpCore(db);
    const revert = act(db, (u) => {
      // 先记子表，再记父行
      u.set('image_characters', 'character_id = ?', [1]);
      u.set('character_works', 'character_id = ?', [1]);
      u.set('characters', 'id = ?', [1]);
      db.prepare('DELETE FROM characters WHERE id = 1').run();
    });
    expect(db.prepare('SELECT count(*) FROM image_characters').pluck().get()).toBe(1);
    await revert();
    expect(dumpCore(db)).toEqual(before);
  });

  it('自定义反向 SQL', async () => {
    const before = dumpCore(db);
    const revert = act(db, (u) => {
      db.prepare("UPDATE images SET rating = 'sensitive' WHERE id = 1").run();
      u.sql("UPDATE images SET rating = 'general' WHERE id = 1");
    });
    await revert();
    expect(dumpCore(db)).toEqual(before);
  });

  it('onUndo 在数据库撤销之后按逆序执行', async () => {
    const calls: string[] = [];
    const u = new UndoRecorder(db);
    u.onUndo(() => void calls.push('a'));
    u.onUndo(() => void calls.push('b'));
    expect(u.isEmpty).toBe(false);
    await u.build()();
    expect(calls).toEqual(['b', 'a']);
  });

  it('撤销时约束冲突 → ConflictError，库保持撤销前状态', async () => {
    const revert = act(db, (u) => {
      u.set('image_characters', 'image_id = ?', [1]);
      db.prepare('DELETE FROM image_characters WHERE image_id = 1').run();
    });
    // 撤销前把被引用的图片删掉，恢复关联时外键失败
    db.prepare('DELETE FROM images WHERE id = 1').run();
    const snapshot = dumpCore(db);
    await expect(revert()).rejects.toBeInstanceOf(ConflictError);
    expect(dumpCore(db)).toEqual(snapshot);
  });

  it('空记录器', () => {
    expect(new UndoRecorder(db).isEmpty).toBe(true);
    closeDatabase(db);
  });
});
