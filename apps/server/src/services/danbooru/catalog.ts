/**
 * Danbooru 元数据的本地缓存（danbooru_tags 表）。全部同步方法，可在事务里用。
 * 同时是完整的「角色 → 作品」回退链：在线 > 离线表 > 词库猜测 > 限定词猜测 > []。
 * 写入在主人模块里：元数据是证据（domain/evidence/danbooru.ts），改名表和名字反查是编目的（domain/catalog/nameIndex.ts）。
 */
import { searchKey } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import { recordDanbooruRename, replaceDanbooruOtherNames } from '../../domain/catalog/nameIndex.ts';
import {
  markDanbooruAlias,
  markDanbooruNotFound,
  setDanbooruCopyrights,
  setDanbooruOtherNames,
  upsertDanbooruTag,
} from '../../domain/evidence/danbooru.ts';
import type { CopyrightResolver, CopyrightSource } from '../catalog/copyrights.ts';
import type { OfflineCharacterIndex } from '../catalog/offlineCharacters.ts';
import { verifiedCharacterWorks } from '../catalog/verifiedNames.ts';
import { CharacterVerifications } from '../catalog/characterVerification.ts';
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
/** 单层括号的服装变体：minato_aqua_(1st_costume) → minato_aqua（括号里是作品名时不算，那是区分同名角色的） */
const SINGLE = /^(.+)_\(([^()]+)\)$/;

/** 去掉括号后的名字（按下划线切词）里，本体的名字是不是连续出现在变体里：yuudachi_kai_ni_(kancolle) ⊃ yuudachi */
export function sameLineage(variant: string, base: string): boolean {
  const words = (t: string) => t.replace(/_\([^()]*\)/g, '').split('_').filter(Boolean);
  const v = words(variant);
  const b = words(base);
  if (!b.length || b.length > v.length) return false;
  for (let i = 0; i + b.length <= v.length; i++) if (b.every((w, k) => v[i + k] === w)) return true;
  return false;
}

export class DanbooruCatalog implements CopyrightSource {
  private readonly s: Record<string, Statement>;
  readonly verifications: CharacterVerifications;

  constructor(
    private readonly db: Db,
    private readonly offline: CopyrightResolver,
    readonly offlineCharacters?: OfflineCharacterIndex,
  ) {
    this.verifications = new CharacterVerifications(db);
    this.s = {
      get: db.prepare('SELECT * FROM danbooru_tags WHERE name = ?'),
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
      libraryCharacter: db.prepare('SELECT 1 FROM characters WHERE danbooru_tag = ?').pluck(),
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
    upsertDanbooruTag(this.db, t, now);
  }

  /** 旧名改成了新名：元数据记 alias_of（证据），改名表记一条（编目） */
  markAlias(oldName: string, newName: string, now: string): void {
    if (oldName === newName) return;
    markDanbooruAlias(this.db, oldName, newName, now);
    recordDanbooruRename(this.db, oldName, newName);
  }

  markNotFound(name: string, now: string): void {
    markDanbooruNotFound(this.db, name, now);
  }

  /** wiki 的其他名字：元数据（证据）和名字反查（编目）一起换 */
  setOtherNames(name: string, names: string[], now: string): void {
    setDanbooruOtherNames(this.db, name, names, now);
    replaceDanbooruOtherNames(this.db, name, names);
  }

  setCopyrights(name: string, list: string[], now: string): void {
    setDanbooruCopyrights(this.db, name, list, now);
  }

  /**
   * 顺着 tag_renames 最多 3 跳。作品标签的规范化就是它（CharacterCatalog.normalizeWorkTag）；
   * 角色标签用 normalizeTag（它的第一步也是这个）。名字查找（显示名、名字索引）也先按改名表换成现在的名字
   */
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
    // implication 里的角色只在「名字里含本体名字」时才算变体（夕立改二 → 夕立）；Saber Alter → 阿尔托莉雅、
    // 斯卡哈·斯卡蒂 → 斯卡哈 这类名字不同的，粉丝眼里是另一个角色，不归并（用户 2026-09-28）
    const fromImplies = this.impliesClosure(tag).find(
      (t) => (this.s.category!.get(t) as number | undefined) === 4 && sameLineage(tag, t),
    );
    if (fromImplies) return fromImplies;
    const m = VARIANT.exec(tag);
    if (m) {
      const base = `${m[1]}_(${m[2]})`;
      if (this.s.isCharacter!.get({ t: base }) || this.offline.offline[base]) return base;
    }
    // 单层括号：本体是已知角色、括号里又不是作品名时，才算服装变体（用户 2026-09-28 定：变体都归本体）
    const one = SINGLE.exec(tag);
    if (one && !this.isCopyright(one[2]!)) {
      const base = one[1]!;
      if (this.s.isCharacter!.get({ t: base }) || this.s.libraryCharacter!.get(base) || this.offline.offline[base]) return base;
    }
    return tag;
  }

  /** 括号里的限定词是不是作品名（hoshino_ai_(oshi_no_ko) 的 oshi_no_ko） */
  private isCopyright(qualifier: string): boolean {
    return !!(
      this.s.i18nCopyright!.get(qualifier) ??
      this.s.keyCopyright!.get(searchKey(qualifier)) ??
      this.s.dbCopyright!.get(qualifier)
    );
  }

  /** 只按 Danbooru 的规则（改名、服装变体归本体）：normalizeTag 的一步，不单独对外 */
  private danbooruBase(tag: string): string {
    // 改名、变体归本体交替做到不再变化为止（本体本身也可能改过名，归完还能再归）：
    // 结果必须幂等，调用方可能对已经规范化的标签再规范化一次（2026-09-28 的 UNIQUE 冲突）
    let t = tag;
    for (let i = 0; i < 4; i++) {
      const next = this.canonicalize(this.baseCharacter(this.canonicalize(t)));
      if (next === t) break;
      t = next;
    }
    return t;
  }

  /**
   * 角色标签 → 身份标签：改名、服装变体归本体、核验过的身份（character_verified_forms）。
   * 编目里角色标签只有这一个规范化（附录 #37），经 CharacterCatalog.normalizeTag 用：解析、建角色、收拢都一样
   */
  normalizeTag(tag: string): string {
    const canonical = this.canonicalize(tag);
    const verified = this.verifications.base(canonical) ?? this.verifications.base(tag);
    if (verified) return this.danbooruBase(verified);
    const base = this.danbooruBase(canonical);
    const verifiedBase = this.verifications.base(base);
    return verifiedBase ? this.danbooruBase(verifiedBase) : base;
  }

  knowsCharacterTag(tag: string): boolean {
    return !!(this.s.isCharacter!.get({ t: tag }) || this.s.libraryCharacter!.get(tag) ||
      Object.hasOwn(this.offline.offline, tag) || this.offlineCharacters?.character(tag));
  }

  /** 角色所属的作品标签，按改名表换成现在的名字（旧名建出来的作品会和新名的重复） */
  copyrights(characterTag: string): string[] {
    return [...new Set(this.rawCopyrights(characterTag).map((c) => this.canonicalize(c)))];
  }

  private rawCopyrights(characterTag: string): string[] {
    const t = this.canonicalize(characterTag);
    const cached = this.get(t);
    if (cached?.relatedFetchedAt && cached.copyrights?.length) return cached.copyrights;
    const verified = verifiedCharacterWorks[t];
    if (verified?.length) return [...verified];
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
    return q ? [q] : this.offlineCharacters?.character(t)?.works ?? [];
  }
}
