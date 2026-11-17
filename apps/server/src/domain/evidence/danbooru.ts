/**
 * Danbooru 元数据（证据，docs/core-architecture.md 第 2.4 节）：danbooru_tags、danbooru_artists 只经这里写。
 * 读和标签规范化在 services/danbooru/catalog.ts（DanbooruCatalog）；由元数据推出的名字索引、改名表是编目的（domain/catalog/nameIndex.ts）。
 * 全是同步函数，可以在调用方的事务里用。
 */
import type { Db, Statement } from '../../db/connection.ts';
import type { DbTag } from '../../services/danbooru/types.ts';

const cache = new WeakMap<Db, Map<string, Statement>>();
const stmt = (db: Db, sql: string): Statement => {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
};

/** 标签的基本元数据（分类、张数、implication）；以前标成改名 / 查不到的一并清掉 */
export function upsertDanbooruTag(db: Db, t: DbTag, now: string): void {
  stmt(
    db,
    `INSERT INTO danbooru_tags (name, category, post_count, fetched_at, implies, is_deprecated, not_found, alias_of)
     VALUES (@name, @category, @post_count, @now, @implies, @is_deprecated, 0, NULL)
     ON CONFLICT(name) DO UPDATE SET category = excluded.category, post_count = excluded.post_count,
       fetched_at = excluded.fetched_at, implies = excluded.implies, is_deprecated = excluded.is_deprecated,
       not_found = 0, alias_of = NULL`,
  ).run({
    name: t.name,
    category: t.category,
    post_count: t.post_count,
    now,
    implies: JSON.stringify(t.antecedent_implications.map((x) => x.consequent_name)),
    is_deprecated: t.is_deprecated ? 1 : 0,
  });
}

/** 旧标签名已被 Danbooru 改成新名（只记元数据；改名表由编目记，见 DanbooruCatalog.markAlias） */
export function markDanbooruAlias(db: Db, oldName: string, newName: string, now: string): void {
  stmt(
    db,
    `INSERT INTO danbooru_tags (name, category, fetched_at, alias_of) VALUES (?, -1, ?, ?)
     ON CONFLICT(name) DO UPDATE SET alias_of = excluded.alias_of, fetched_at = excluded.fetched_at, not_found = 0`,
  ).run(oldName, now, newName);
}

export function markDanbooruNotFound(db: Db, name: string, now: string): void {
  stmt(
    db,
    `INSERT INTO danbooru_tags (name, category, fetched_at, not_found) VALUES (?, -1, ?, 1)
     ON CONFLICT(name) DO UPDATE SET not_found = 1, fetched_at = excluded.fetched_at`,
  ).run(name, now);
}

/** wiki 里的其他名字（没有 wiki 也记 wiki_fetched_at） */
export function setDanbooruOtherNames(db: Db, name: string, names: string[], now: string): void {
  stmt(db, 'UPDATE danbooru_tags SET other_names = ?, wiki_fetched_at = ? WHERE name = ?').run(JSON.stringify(names), now, name);
}

/** 角色所属的作品（related_tag 算出来的） */
export function setDanbooruCopyrights(db: Db, name: string, list: string[], now: string): void {
  stmt(db, 'UPDATE danbooru_tags SET copyrights = ?, related_fetched_at = ? WHERE name = ?').run(JSON.stringify(list), now, name);
}

export interface DanbooruArtistRow {
  name: string;
  display: string | null;
  /** JSON string[] */
  names: string;
  twitter: string | null;
  alias: string | null;
  /** 1 = 查不到 */
  nf: number;
  now: string;
}

/** 画师资料（显示名、其他名字、推特、改名） */
export function putDanbooruArtist(db: Db, row: DanbooruArtistRow): void {
  stmt(
    db,
    `INSERT INTO danbooru_artists (name, display, names, twitter, alias_of, not_found, fetched_at)
     VALUES (@name, @display, @names, @twitter, @alias, @nf, @now)
     ON CONFLICT(name) DO UPDATE SET display = excluded.display, names = excluded.names, twitter = excluded.twitter,
       alias_of = excluded.alias_of, not_found = excluded.not_found, fetched_at = excluded.fetched_at`,
  ).run(row);
}
