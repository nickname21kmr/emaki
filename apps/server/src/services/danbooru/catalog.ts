/**
 * Danbooru 元数据的本地缓存（danbooru_tags 表）。全部同步方法，可在事务里用。
 * 同时是完整的「角色 → 作品」回退链：在线 > 离线表 > 词库猜测 > 限定词猜测 > []。
 */
import { searchKey } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import type { CopyrightResolver, CopyrightSource } from '../catalog/copyrights.ts';
import { guessCopyrightFromQualifier } from './copyright.ts';
import type { DbTag } from './types.ts';

export interface CachedTag {
  name: string;
  category: number;
  postCount: number;
  copyrights: string[] | null;
  otherNames: string[];
  aliasOf: string | null;
  implies: string[];
  notFound: boolean;
  fetchedAt: string;
  wikiFetchedAt: string | null;
  relatedFetchedAt: string | null;
}

interface Row {
  name: string;
  category: number;
  post_count: number;
  copyrights: string | null;
  other_names: string | null;
  alias_of: string | null;
  implies: string | null;
  not_found: number;
  fetched_at: string;
  wiki_fetched_at: string | null;
  related_fetched_at: string | null;
}

const arr = (s: string | null): string[] => {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** 服装变体：mika_(swimsuit)_(blue_archive) → mika_(blue_archive) */
const VARIANT = /^(.+)_\([^()]+\)_\(([^()]+)\)$/;

export class DanbooruCatalog implements CopyrightSource {
  private readonly s: Record<string, Statement>;

  constructor(
    private readonly db: Db,
    private readonly offline: CopyrightResolver,
  ) {
    this.s = {
      get: db.prepare('SELECT * FROM danbooru_tags WHERE name = ?'),
      upsertBase: db.prepare(`INSERT INTO danbooru_tags (name, category, post_count, fetched_at, implies, is_deprecated, not_found, alias_of)
        VALUES (@name, @category, @post_count, @now, @implies, @is_deprecated, 0, NULL)
        ON CONFLICT(name) DO UPDATE SET category = excluded.category, post_count = excluded.post_count,
          fetched_at = excluded.fetched_at, implies = excluded.implies, is_deprecated = excluded.is_deprecated,
          not_found = 0, alias_of = NULL`),
      markAlias: db.prepare(`INSERT INTO danbooru_tags (name, category, fetched_at, alias_of) VALUES (?, -1, ?, ?)
        ON CONFLICT(name) DO UPDATE SET alias_of = excluded.alias_of, fetched_at = excluded.fetched_at, not_found = 0`),
      rename: db.prepare("INSERT OR REPLACE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'danbooru')"),
      markNotFound: db.prepare(`INSERT INTO danbooru_tags (name, category, fetched_at, not_found) VALUES (?, -1, ?, 1)
        ON CONFLICT(name) DO UPDATE SET not_found = 1, fetched_at = excluded.fetched_at`),
      setOther: db.prepare('UPDATE danbooru_tags SET other_names = ?, wiki_fetched_at = ? WHERE name = ?'),
      delOtherKeys: db.prepare("DELETE FROM tag_name_keys WHERE tag = ? AND kind = 'other_name' AND source = 'danbooru'"),
      insKey: db.prepare('INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, ?, ?)'),
      setCopyrights: db.prepare('UPDATE danbooru_tags SET copyrights = ?, related_fetched_at = ? WHERE name = ?'),
      renameStep: db.prepare('SELECT new_name FROM tag_renames WHERE old_name = ?').pluck(),
      i18nGuess: db.prepare('SELECT copyright_guess FROM tag_i18n WHERE tag = ?').pluck(),
      i18nCopyright: db.prepare('SELECT tag FROM tag_i18n WHERE tag = ? AND category = 3').pluck(),
      keyCopyright: db
        .prepare(
          `SELECT k.tag FROM tag_name_keys k JOIN tag_i18n i ON i.tag = k.tag AND i.category = 3
           WHERE k.search_key = ? ORDER BY i.post_count DESC LIMIT 1`,
        )
        .pluck(),
      dbCopyright: db.prepare('SELECT name FROM danbooru_tags WHERE name = ? AND category = 3').pluck(),
      isCharacter: db
        .prepare(
          'SELECT 1 FROM tag_i18n WHERE tag = @t AND category = 4 UNION ALL SELECT 1 FROM danbooru_tags WHERE name = @t AND category = 4 LIMIT 1',
        )
        .pluck(),
      category: db.prepare('SELECT category FROM danbooru_tags WHERE name = ?').pluck(),
    };
  }

  get(name: string): CachedTag | null {
    const r = this.s.get!.get(name) as Row | undefined;
    if (!r) return null;
    return {
      name: r.name,
      category: r.category,
      postCount: r.post_count,
      copyrights: r.copyrights === null ? null : arr(r.copyrights),
      otherNames: arr(r.other_names),
      aliasOf: r.alias_of,
      implies: arr(r.implies),
      notFound: r.not_found === 1,
      fetchedAt: r.fetched_at,
      wikiFetchedAt: r.wiki_fetched_at,
      relatedFetchedAt: r.related_fetched_at,
    };
  }

  /** 没有行 / fetched_at 过期 */
  needsMeta(name: string, staleBefore: string): boolean {
    const r = this.get(name);
    return !r || r.fetchedAt < staleBefore;
  }

  upsertBase(t: DbTag, now: string): void {
    this.s.upsertBase!.run({
      name: t.name,
      category: t.category,
      post_count: t.post_count,
      now,
      implies: JSON.stringify(t.antecedent_implications.map((x) => x.consequent_name)),
      is_deprecated: t.is_deprecated ? 1 : 0,
    });
  }

  markAlias(oldName: string, newName: string, now: string): void {
    if (oldName === newName) return;
    this.s.markAlias!.run(oldName, now, newName);
    this.s.rename!.run(oldName, newName);
  }

  markNotFound(name: string, now: string): void {
    this.s.markNotFound!.run(name, now);
  }

  setOtherNames(name: string, names: string[], now: string): void {
    this.s.setOther!.run(JSON.stringify(names), now, name);
    this.s.delOtherKeys!.run(name);
    for (const n of names) {
      const k = searchKey(n);
      if (k) this.s.insKey!.run(k, name, 'other_name', 'danbooru');
    }
  }

  setCopyrights(name: string, list: string[], now: string): void {
    this.s.setCopyrights!.run(JSON.stringify(list), now, name);
  }

  /** 顺着 tag_renames 最多 3 跳 */
  canonicalize(tag: string): string {
    let t = tag;
    for (let i = 0; i < 3; i++) {
      const next = this.s.renameStep!.get(t) as string | undefined;
      if (!next || next === t) break;
      t = next;
    }
    return t;
  }

  /** implies 传递闭包，最多 5 层 */
  impliesClosure(tag: string): string[] {
    const out = new Set<string>();
    let frontier = [tag];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next: string[] = [];
      for (const t of frontier) {
        for (const i of this.get(t)?.implies ?? []) {
          if (!out.has(i) && i !== tag) {
            out.add(i);
            next.push(i);
          }
        }
      }
      frontier = next;
    }
    return [...out];
  }

  /** 服装变体 → 本体：先看在线 implication 里的角色，再用正则（本体确实存在时才采用） */
  baseCharacter(tag: string): string {
    const fromImplies = this.impliesClosure(tag).find((t) => (this.s.category!.get(t) as number | undefined) === 4);
    if (fromImplies) return fromImplies;
    const m = VARIANT.exec(tag);
    if (m) {
      const base = `${m[1]}_(${m[2]})`;
      if (this.s.isCharacter!.get({ t: base }) || this.offline.offline[base]) return base;
    }
    return tag;
  }

  /** 给 T10 CharacterCatalog 的 normalizeTag */
  normalizeTag(tag: string): string {
    return this.baseCharacter(this.canonicalize(tag));
  }

  copyrights(characterTag: string): string[] {
    const t = this.canonicalize(characterTag);
    const cached = this.get(t);
    if (cached?.relatedFetchedAt && cached.copyrights?.length) return cached.copyrights;
    const off = this.offline.offline[t];
    if (off?.length) return off;
    const guess = this.s.i18nGuess!.get(t) as string | null | undefined;
    if (guess) return [guess];
    const q = guessCopyrightFromQualifier(t, (qualifier) => {
      return (
        (this.s.i18nCopyright!.get(qualifier) as string | undefined) ??
        (this.s.keyCopyright!.get(searchKey(qualifier)) as string | undefined) ??
        (this.s.dbCopyright!.get(qualifier) as string | undefined) ??
        null
      );
    });
    return q ? [q] : [];
  }
}
