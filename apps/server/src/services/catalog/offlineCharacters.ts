import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { katakanaToHiragana, searchKey } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';

export const OFFLINE_CHARACTER_FILE = 'character-index.sqlite';
export const OFFLINE_CHARACTER_VERSION = 1;

// Unlike the UI's search key, this key retains any parenthesized work name.
export const identityKey = (name: string) =>
  katakanaToHiragana(name.normalize('NFKC').toLowerCase().replace(/[\s_=\-·・]+/g, ''));

export interface OfflineCharacter {
  tag: string;
  works: string[];
  names: string[];
}

export function costumeBaseTag(tag: string): string | undefined {
  const costume = /^(.+)_\([^()]+\)_\(([^()]+)\)$/.exec(tag);
  return costume ? `${costume[1]}_(${costume[2]})` : undefined;
}

export class OfflineCharacterIndex {
  private readonly byTag: Statement;
  private readonly exact: Statement;
  private readonly loose: Statement;
  private readonly works: Statement;

  constructor(private readonly db: Db) {
    if (db.pragma('user_version', { simple: true }) !== OFFLINE_CHARACTER_VERSION) {
      throw new Error('Unsupported character index version');
    }
    this.byTag = db.prepare('SELECT tag, works, names FROM character WHERE tag=?');
    this.exact = db.prepare('SELECT tag FROM name WHERE identity_key=? ORDER BY tag LIMIT 51').pluck();
    this.loose = db.prepare('SELECT DISTINCT tag FROM name WHERE search_key=? ORDER BY tag LIMIT 51').pluck();
    this.works = db.prepare('SELECT tag FROM work WHERE identity_key=? ORDER BY tag').pluck();
  }

  static open(dataDir: string, warn: (message: string) => void = console.warn): OfflineCharacterIndex | undefined {
    const file = path.join(dataDir, OFFLINE_CHARACTER_FILE);
    if (!existsSync(file)) return undefined;
    let db: Db | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      return new OfflineCharacterIndex(db);
    } catch (error) {
      db?.close();
      warn(`[character-index] 无法读取离线角色索引：${String(error)}`);
      return undefined;
    }
  }

  character(tag: string): OfflineCharacter | undefined {
    const row = this.byTag.get(tag) as { tag: string; works: string; names: string } | undefined;
    return row && { tag: row.tag, works: JSON.parse(row.works) as string[], names: JSON.parse(row.names) as string[] };
  }

  /** null means the exact name is too common to establish a unique identity. */
  exactCandidates(name: string): string[] | null {
    const tags = this.exact.all(identityKey(name)) as string[];
    return tags.length <= 50 ? tags : null;
  }

  candidates(name: string, exact = true): string[] {
    if (exact) return this.exactCandidates(name) ?? [];
    const tags = this.loose.all(searchKey(name)) as string[];
    return tags.length <= 50 ? tags : [];
  }

  workTags(name: string): string[] {
    return this.works.all(identityKey(name)) as string[];
  }

  costumeBase(tag: string): string {
    const base = costumeBaseTag(tag);
    if (!base) return tag;
    const parent = this.character(base);
    const variant = this.character(tag);
    return parent && variant?.works.some(work => parent.works.includes(work)) ? base : tag;
  }

  close(): void {
    this.db.close();
  }
}
