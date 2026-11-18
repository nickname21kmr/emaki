/**
 * 命名口径的一致性（P5，附录 #24、#25、#26、#27）：
 * - 「在哪个待处理队列」的 SQL 版本（QUEUE_OF）和前端用的 JS 版本（packages/shared 的 triageQueue）逐个组合比对；
 * - 统计、未识别页用的几个队列片段（QUEUE、SHELVED_QUEUE、ANNEX_QUEUE）和 QUEUE_OF 划出来的是同一批图；
 * - 作品数用的三支 EXISTS（WORK_HAS_ILLUSTRATION）和视图 v_image_works ⋈ v_illust_images 等价。
 */
import { CONTENT_KINDS, triageQueue, type ContentKind, type TriageQueue } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import { ANNEX_QUEUE, BOOK_OR_COMIC_IDS, IN_COMIC_I, NOT_IN_BOOK, QUEUE, QUEUE_OF, SHELVED_QUEUE, WORK_HAS_ILLUSTRATION } from './terms.ts';

const AT = '2026-11-18T00:00:00.000Z';

type Visibility = 'counted' | 'excluded' | 'missing' | 'trashed' | 'rootOff';
type Book = 'none' | 'doujin' | 'artbook' | 'group' | 'dismissed';
interface Case {
  id: number;
  kind: ContentKind;
  visibility: Visibility;
  chars: number;
  original: boolean;
  shelved: boolean;
  book: Book;
  comicArea: boolean;
}

/** 一个空库：两个图库文件夹（一个停用）、一个漫画子文件夹、四种合集、一个角色、一条排除规则，加上每种组合各一张图 */
function matrix(): { db: Db; cases: Case[] } {
  const db = openDatabase(':memory:');
  migrate(db, {});
  db.exec(`INSERT INTO library_roots (id, path, enabled) VALUES (1, 'D:/a', 1), (2, 'D:/b', 0);
    INSERT INTO comic_folders (root_id, rel_dir, created_at) VALUES (1, 'comic', '${AT}');
    INSERT INTO characters (id, name, source, created_at) VALUES (1, 'x', 'custom', '${AT}');
    INSERT INTO exclusions (id, kind, target, label, created_at) VALUES (1, 'tag', 't', '标签 · t', '${AT}');`);
  const col = db.prepare(`INSERT INTO collections (id, root_id, rel_dir, kind, kind_source, origin, state, created_at, updated_at)
    VALUES (?, 1, ?, ?, 'auto', 'auto', ?, '${AT}', '${AT}')`);
  const books: Record<Exclude<Book, 'none'>, number> = { doujin: 1, artbook: 2, group: 3, dismissed: 4 };
  col.run(1, 'b1', 'doujin', 'active');
  col.run(2, 'b2', 'artbook', 'active');
  col.run(3, 'g1', 'group', 'active');
  col.run(4, 'b3', 'doujin', 'dismissed');
  const img = db.prepare(`INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at,
      content_kind, excluded_by, missing, trashed_at, original_at, shelved_at, collection_id)
    VALUES (@id, @root, @rel, 'f.png', 10, 10, 1, 'png', 'sha', '${AT}', '${AT}', @kind, @ex, @missing, @trashed, @original, @shelved, @col)`);
  const link = db.prepare(`INSERT INTO image_characters (image_id, character_id, decision, actor, added_at) VALUES (?, 1, 'manual', 'user', '${AT}')`);
  const cases: Case[] = [];
  let id = 0;
  db.transaction(() => {
    for (const kind of CONTENT_KINDS)
      for (const visibility of ['counted', 'excluded', 'missing', 'trashed', 'rootOff'] as const)
        for (const chars of [0, 1])
          for (const original of [false, true])
            for (const shelved of [false, true])
              for (const book of ['none', 'doujin', 'artbook', 'group', 'dismissed'] as const)
                for (const comicArea of [false, true]) {
                  id++;
                  img.run({
                    id,
                    root: visibility === 'rootOff' ? 2 : 1,
                    rel: `${comicArea ? 'comic/' : ''}${id}.png`,
                    kind,
                    ex: visibility === 'excluded' ? 1 : null,
                    missing: visibility === 'missing' ? 1 : 0,
                    trashed: visibility === 'trashed' ? AT : null,
                    original: original ? AT : null,
                    shelved: shelved ? AT : null,
                    col: book === 'none' ? null : books[book],
                  });
                  if (chars) link.run(id);
                  cases.push({ id, kind, visibility, chars, original, shelved, book, comicArea });
                }
  })();
  return { db, cases };
}

const setComicInQueue = (db: Db, on: boolean) =>
  db.prepare(`INSERT INTO settings (key, value) VALUES ('tagger', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify({ comicInUnrecognized: on }),
  );

describe('「在哪个待处理队列」：SQL（QUEUE_OF）和前端的 triageQueue 是同一条规则', () => {
  const { db, cases } = matrix();

  it.each([true, false])('未识别里也列出漫画页 = %s：每种组合的结果都一样', (on) => {
    setComicInQueue(db, on);
    const sql = new Map(
      (db.prepare(`SELECT i.id, ${QUEUE_OF} AS q FROM images i`).all() as { id: number; q: TriageQueue | null }[]).map((r) => [r.id, r.q]),
    );
    const diff = cases.flatMap((c) => {
      const js = triageQueue({
        kind: c.kind,
        counted: c.visibility === 'counted',
        characterCount: c.chars,
        original: c.original,
        shelved: c.shelved,
        // 组图的页照常逐张处理；dismissed（不成册）的合集不算
        inBook: c.book === 'doujin' || c.book === 'artbook',
        inComicArea: c.comicArea,
        comicInQueue: on,
      });
      return sql.get(c.id) === js ? [] : [`${JSON.stringify(c)} SQL=${sql.get(c.id)} JS=${js}`];
    });
    expect(diff).toEqual([]);
    // 每个队列都有图，矩阵没写偏
    expect(new Set(sql.values())).toEqual(new Set(['art', 'shelved', 'annex', 'book', null]));
  });

  it.each([true, false])('统计和未识别页用的队列片段划出来的就是 QUEUE_OF 的那几类（漫画设置 = %s）', (on) => {
    setComicInQueue(db, on);
    const ids = (where: string) => db.prepare(`SELECT i.id FROM v_counted_images i WHERE ${where} ORDER BY i.id`).pluck().all();
    const byQueue = (q: string) => db.prepare(`SELECT i.id FROM images i WHERE (${QUEUE_OF}) = ? ORDER BY i.id`).pluck().all(q);
    expect(ids(QUEUE)).toEqual(byQueue('art'));
    expect(ids(SHELVED_QUEUE)).toEqual(byQueue('shelved'));
    expect(ids(ANNEX_QUEUE)).toEqual(byQueue('annex'));
  });
});

describe('按索引找的「成册或在漫画区」和逐行判断的同一口径', () => {
  it('BOOK_OR_COMIC_IDS = NOT NOT_IN_BOOK OR IN_COMIC（整个文件夹按漫画导入、子文件夹、本子、画集；组图和不成册的不算）', () => {
    const { db } = matrix();
    db.exec(`UPDATE library_roots SET content_mode = 'comic' WHERE id = 2;
      INSERT INTO comic_folders (root_id, rel_dir, created_at) VALUES (1, 'com', '${AT}');
      INSERT INTO images (id, root_id, rel_path, file_name, width, height, bytes, format, sha256, added_at, modified_at)
        VALUES (99001, 1, 'com/a.png', 'a.png', 1, 1, 1, 'png', 's', '${AT}', '${AT}'), (99002, 1, 'comic0/a.png', 'a.png', 1, 1, 1, 'png', 's', '${AT}', '${AT}'),
               (99003, 1, 'comicx.png', 'comicx.png', 1, 1, 1, 'png', 's', '${AT}', '${AT}');`);
    const ids = (sql: string) => db.prepare(sql).pluck().all();
    const byRow = ids(`SELECT i.id FROM images i WHERE NOT ${NOT_IN_BOOK} OR ${IN_COMIC_I} ORDER BY i.id`);
    expect(ids(`SELECT id FROM (${BOOK_OR_COMIC_IDS}) ORDER BY id`)).toEqual(byRow);
    expect(byRow).toContain(99001);
    expect(byRow).not.toContain(99002);
    expect(byRow).not.toContain(99003);
  });
});

describe('作品数和作品列表同一口径（附录 #26）', () => {
  it('WORK_HAS_ILLUSTRATION 和 v_image_works ⋈ v_illust_images 等价：手动指定的作品、关联角色的作品、原创', () => {
    const { db } = matrix();
    db.exec(`INSERT INTO works (id, name, danbooru_tag, created_at) VALUES (1, '甲', 'a', '${AT}'), (2, '乙', 'b', '${AT}'),
        (3, '原创', 'original', '${AT}'), (4, '丙', 'c', '${AT}'), (5, '丁', 'd', '${AT}');
      INSERT INTO character_works (character_id, work_id, position) VALUES (1, 1, 0);
      -- 原创图手动指定了别的作品：只算「原创」（迁移 030）；非原创图手动指定乙；模型给的作品（丙）是证据，不算
      INSERT INTO image_copyrights (image_id, work_id) SELECT id, 4 FROM images WHERE original_at IS NOT NULL LIMIT 3;
      INSERT INTO image_copyrights (image_id, work_id) SELECT id, 2 FROM images WHERE original_at IS NULL LIMIT 3;
      INSERT INTO work_evidence (image_id, provider, tag, score) SELECT id, 'tagger', 'd', 0.9 FROM images LIMIT 5;`);
    const fast = db.prepare(`SELECT w.id FROM works w WHERE ${WORK_HAS_ILLUSTRATION} ORDER BY w.id`).pluck().all();
    const view = db
      .prepare('SELECT DISTINCT vw.work_id FROM v_image_works vw JOIN v_illust_images i ON i.id = vw.image_id ORDER BY vw.work_id')
      .pluck()
      .all();
    expect(fast).toEqual(view);
    expect(fast).toEqual([1, 2, 3]);
  });
});
