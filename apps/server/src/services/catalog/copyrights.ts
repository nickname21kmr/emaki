/**
 * 角色标签 → 作品标签列表（第一个 = 主作品）。T11 会在外面包一层完整的回退链。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import type { Db, Statement } from '../../db/connection.ts';

export interface CopyrightSource {
  copyrights(tag: string): string[];
}

export class CopyrightResolver implements CopyrightSource {
  private readonly stmt: Statement;

  constructor(
    db: Db,
    readonly offline: Readonly<Record<string, string[]>>,
  ) {
    this.stmt = db.prepare('SELECT copyrights FROM danbooru_tags WHERE name = ?');
  }

  static fromAsset(db: Db, file = path.join(config.assetsDir, 'character-ips.json')): CopyrightResolver {
    let map: Record<string, string[]> = {};
    try {
      map = (JSON.parse(readFileSync(file, 'utf8')) as { characters: Record<string, string[]> }).characters;
    } catch {
      /* 没有离线表也能跑，只是不自动建作品 */
    }
    return new CopyrightResolver(db, map);
  }

  /** ① T11 同步下来的 danbooru_tags.copyrights（非空才算）② 离线表 */
  copyrights(tag: string): string[] {
    const row = this.stmt.get(tag) as { copyrights: string | null } | undefined;
    if (row?.copyrights) {
      try {
        const a: unknown = JSON.parse(row.copyrights);
        if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return a as string[];
      } catch {
        /* 坏数据忽略 */
      }
    }
    return this.offline[tag] ?? this.fromQualifier(tag);
  }

  /** 离线表里出现过的全部作品标签（判断括号里的是不是作品） */
  private known: Set<string> | null = null;

  /**
   * ③ 新角色（离线表生成之后才有的，例如 sigrika_(wuthering_waves)）：Danbooru 的角色标签在括号里写作品名，
   * 括号里是已知作品就用它。只认已知作品，避免把 (cosplay)、(swimsuit) 这类括号当成作品。
   */
  private fromQualifier(tag: string): string[] {
    const m = /_\(([^()]+)\)$/.exec(tag);
    if (!m) return [];
    this.known ??= new Set(Object.values(this.offline).flat());
    return this.known.has(m[1]!) ? [m[1]!] : [];
  }
}
