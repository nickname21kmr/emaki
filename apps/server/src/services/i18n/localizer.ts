/**
 * 标签 → 显示名 / 别名。接口签名固定（T11 / T12 不改）；T12 提供读词库的真实实现 SqliteLocalizer。
 */
import { searchKey } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import type { DanbooruCatalog } from '../danbooru/catalog.ts';
import { cleanOtherName, humanizeCharacterTag, humanizeCopyrightTag, stripZhQualifier } from './humanize.ts';
import { hasKana, isHanName, isLatinName, isNeutralHan, isSimplifiedZh, toSimplified } from './script.ts';

export type NameSource = 'dict' | 'wiki-zh' | 'wiki-converted' | 'wiki-ja' | 'tag';

export interface LocalizedName {
  name: string;
  source: NameSource;
}

export interface AutoAlias {
  alias: string;
  origin: 'dict' | 'danbooru';
  /** false = 只用于搜索，不出现在 Character.aliases 里 */
  visible: boolean;
}

export interface Localizer {
  characterName(tag: string): LocalizedName;
  workName(tag: string): LocalizedName;
  aliasesFor(tag: string, owner: 'character' | 'work', displayName: string): AutoAlias[];
  invalidate(): void;
}

/** T12 之前的占位实现：只会 humanize */
export class HumanizeLocalizer implements Localizer {
  characterName(tag: string): LocalizedName {
    return { name: humanizeCharacterTag(tag), source: 'tag' };
  }

  workName(tag: string): LocalizedName {
    return { name: humanizeCopyrightTag(tag), source: 'tag' };
  }

  /** 原始标签（只供搜索）+ 人性化名字；按 searchKey 去重，去掉与 displayName 同 key 的 */
  aliasesFor(tag: string, owner: 'character' | 'work', displayName: string): AutoAlias[] {
    const human = owner === 'character' ? humanizeCharacterTag(tag) : humanizeCopyrightTag(tag);
    const seen = new Set([searchKey(displayName)]);
    const out: AutoAlias[] = [];
    for (const a of [
      { alias: tag, origin: 'danbooru' as const, visible: false },
      { alias: human, origin: 'danbooru' as const, visible: true },
    ]) {
      const k = searchKey(a.alias);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out;
  }

  invalidate(): void {}
}

// ---------------------------------------------------------------- 读词库的真实实现（T12）

/**
 * 显示名优先级：词库中文名 → wiki 里的简体名 → wiki 汉字名转简体 → wiki 日文名 → 人性化标签。
 * 结果按标签缓存，词库 / 同步更新后 invalidate()。
 */
export class SqliteLocalizer implements Localizer {
  private readonly names = new Map<string, LocalizedName>();
  private readonly dictStmt: Statement;
  private readonly otherStmt: Statement;

  constructor(
    db: Db,
    private readonly danbooru: Pick<DanbooruCatalog, 'canonicalize'>,
  ) {
    this.dictStmt = db.prepare('SELECT zh, aliases FROM tag_i18n WHERE tag = ?');
    this.otherStmt = db.prepare('SELECT other_names FROM danbooru_tags WHERE name = ?').pluck();
  }

  private dict(tag: string): { zh: string | null; aliases: string[] } | null {
    const r = this.dictStmt.get(tag) as { zh: string | null; aliases: string } | undefined;
    if (!r) return null;
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(r.aliases) as string[];
    } catch {
      /* 坏数据忽略 */
    }
    return { zh: r.zh, aliases };
  }

  private otherNames(tag: string): string[] {
    const raw = this.otherStmt.get(tag) as string | null | undefined;
    if (!raw) return [];
    try {
      return (JSON.parse(raw) as string[]).map(cleanOtherName).filter((x): x is string => !!x);
    } catch {
      return [];
    }
  }

  private resolve(rawTag: string, owner: 'character' | 'work'): LocalizedName {
    const key = `${owner}:${rawTag}`;
    const hit = this.names.get(key);
    if (hit) return hit;
    const tag = this.danbooru.canonicalize(rawTag);
    const d = this.dict(tag) ?? this.dict(rawTag);
    let out: LocalizedName;
    if (d?.zh) {
      // 角色的中文名常带作品后缀「圣园未花（蔚蓝档案）」，去掉；作品名不去
      out = { name: owner === 'character' ? stripZhQualifier(d.zh) : d.zh, source: 'dict' };
    } else {
      const names = this.otherNames(tag);
      const zh = names.find(isSimplifiedZh) ?? names.find(isNeutralHan);
      const han = names.find(isHanName);
      const ja = names.find(hasKana);
      out = zh
        ? { name: zh, source: 'wiki-zh' }
        : han
          ? { name: toSimplified(han), source: 'wiki-converted' }
          : ja
            ? { name: ja, source: 'wiki-ja' }
            : { name: owner === 'character' ? humanizeCharacterTag(tag) : humanizeCopyrightTag(tag), source: 'tag' };
    }
    this.names.set(key, out);
    return out;
  }

  characterName(tag: string): LocalizedName {
    return this.resolve(tag, 'character');
  }

  workName(tag: string): LocalizedName {
    return this.resolve(tag, 'work');
  }

  aliasesFor(rawTag: string, owner: 'character' | 'work', displayName: string): AutoAlias[] {
    const tag = this.danbooru.canonicalize(rawTag);
    const d = this.dict(tag) ?? this.dict(rawTag);
    const others = this.otherNames(tag);
    const human = owner === 'character' ? humanizeCharacterTag(tag) : humanizeCopyrightTag(tag);
    const maxVisible = owner === 'character' ? 4 : 3;

    const seen = new Set([searchKey(displayName)]);
    const out: AutoAlias[] = [];
    const add = (alias: string | undefined, origin: AutoAlias['origin'], visible: boolean) => {
      if (!alias) return;
      const k = searchKey(alias);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ alias, origin, visible });
    };

    // 可见：① 日文 / 非简体的正式名 ② 拉丁名（没有就用人性化标签）③ 词库里的汉字别名
    const visible: [string | undefined, AutoAlias['origin']][] = [];
    const jaName = others.find((n) => hasKana(n) || (isHanName(n) && !isSimplifiedZh(n) && !isNeutralHan(n)));
    visible.push([jaName, 'danbooru']);
    const latin = others.find((n) => isLatinName(n) && /\s/.test(n));
    visible.push(latin ? [latin, 'danbooru'] : [human, 'dict']);
    for (const a of d?.aliases ?? []) if (isHanName(a)) visible.push([a, 'dict']);
    for (const [alias, origin] of visible) {
      if (out.filter((x) => x.visible).length >= maxVisible) break;
      add(alias, origin, true);
    }

    // 隐藏（只用于搜索）：其余 other_names、词库全部别名、词库全称、原始标签、人性化标签
    const hidden: [string | undefined, AutoAlias['origin']][] = [
      ...others.map((n): [string, AutoAlias['origin']] => [n, 'danbooru']),
      ...(d?.aliases ?? []).map((a): [string, AutoAlias['origin']] => [a, 'dict']),
      [d?.zh ?? undefined, 'dict'],
      [rawTag, 'dict'],
      [tag, 'dict'],
      [human, 'dict'],
    ];
    for (const [alias, origin] of hidden) {
      if (out.length >= maxVisible + 40) break;
      add(alias, origin, false);
    }
    return out;
  }

  invalidate(): void {
    this.names.clear();
  }
}
