/**
 * 名字索引和词库（编目的表）：tag_i18n（中文词库）、tag_name_keys（名字 → 标签的反查）、tag_renames（旧标签名 → 新标签名）。
 * 来源有两个：随仓库分发的中文词库（source = 'dict'，整份替换）和 Danbooru 同步（source = 'danbooru'，按标签更新）。
 * Danbooru 元数据本身（danbooru_tags）是证据，在 domain/evidence/danbooru.ts。全是同步函数，可以在调用方的事务里用。
 */
import { searchKey } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import { stripZhQualifier } from '../../services/i18n/humanize.ts';

const cache = new WeakMap<Db, Map<string, Statement>>();
const stmt = (db: Db, sql: string): Statement => {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
};

/** Danbooru 的改名（优先于词库里的：INSERT OR REPLACE） */
export function recordDanbooruRename(db: Db, oldName: string, newName: string): void {
  stmt(db, "INSERT OR REPLACE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'danbooru')").run(oldName, newName);
}

/** 整体替换一个标签在 Danbooru wiki 里的其他名字（other_name）的反查 */
export function replaceDanbooruOtherNames(db: Db, tag: string, names: string[]): void {
  stmt(db, "DELETE FROM tag_name_keys WHERE tag = ? AND kind = 'other_name' AND source = 'danbooru'").run(tag);
  for (const n of names) {
    const k = searchKey(n);
    if (k) addDanbooruOtherName(db, k, tag);
  }
}

/** 加一条 Danbooru 的其他名字反查（自建角色在线匹配时，autocomplete 认出来的名字） */
export function addDanbooruOtherName(db: Db, key: string, tag: string): void {
  stmt(db, "INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, 'other_name', 'danbooru')").run(key, tag);
}

/** 词库的一条：[category, zh | null, aliases, copyrightGuess | null, postCount] */
export type DictEntry = [number, string | null, string[], string | null, number];

/** key 为空、或纯 ASCII 且长度 < 2 的跳过 */
const usable = (k: string) => !!k && !(/^[\x00-\x7f]*$/.test(k) && k.length < 2);

/** 整份替换中文词库（tag_i18n 全部、tag_name_keys / tag_renames 里 source = 'dict' 的）。调用方负责事务和记版本。返回导入的条数 */
export function replaceDictionary(db: Db, tags: Record<string, DictEntry>, renames: Record<string, string>): number {
  db.exec("DELETE FROM tag_i18n; DELETE FROM tag_name_keys WHERE source = 'dict'; DELETE FROM tag_renames WHERE source = 'dict';");
  const insTag = db.prepare('INSERT INTO tag_i18n (tag, category, zh, aliases, copyright_guess, post_count) VALUES (?, ?, ?, ?, ?, ?)');
  const insKey = db.prepare("INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, ?, 'dict')");
  const insRename = db.prepare("INSERT OR IGNORE INTO tag_renames (old_name, new_name, source) VALUES (?, ?, 'dict')");
  let count = 0;
  for (const [tag, [category, zh, aliases, guess, postCount]] of Object.entries(tags)) {
    insTag.run(tag, category, zh, JSON.stringify(aliases), guess, postCount);
    if (zh) {
      const k = searchKey(stripZhQualifier(zh));
      if (usable(k)) insKey.run(k, tag, 'zh');
    }
    for (const a of aliases) {
      const k = searchKey(a);
      if (usable(k)) insKey.run(k, tag, 'alias');
    }
    const k = searchKey(tag);
    if (usable(k)) insKey.run(k, tag, 'tag');
    count++;
  }
  for (const [oldName, newName] of Object.entries(renames)) insRename.run(oldName, newName);
  return count;
}
