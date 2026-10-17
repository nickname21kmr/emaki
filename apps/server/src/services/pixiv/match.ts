import { searchKey, katakanaToHiragana } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import type { PixivArtwork } from './client.ts';

type Index = Map<string, Set<string>>;
const fullKey = (name: string) => katakanaToHiragana(name.normalize('NFKC').toLowerCase().replace(/[\s_\-·・]+/g, ''));
function add(index: Index, name: string, tag: string) {
  const key = searchKey(name);
  if (!key) return;
  const tags = index.get(key) ?? new Set<string>();
  tags.add(tag);
  index.set(key, tags);
}

/** 精确匹配名称/别名，不按包含关系猜角色；同名时用投稿里的作品标签消歧。 */
export function createPixivMatcher(db: Db, catalog: CharacterCatalog, copyrights: CopyrightSource) {
  const characters: Index = new Map();
  const works: Index = new Map();
  const general = new Set<string>();
  const qualifiedGeneral = new Set<string>();
  const rows = db.prepare(`
    SELECT k.search_key AS name, k.tag, COALESCE(d.category, t.category) AS category
    FROM tag_name_keys k LEFT JOIN danbooru_tags d ON d.name=k.tag LEFT JOIN tag_i18n t ON t.tag=k.tag
    WHERE COALESCE(d.category, t.category) IN (0,3,4)
    UNION SELECT name, COALESCE(danbooru_tag, 'emaki:character:' || id), 4 FROM characters
    UNION SELECT a.alias, COALESCE(c.danbooru_tag, 'emaki:character:' || c.id), 4 FROM aliases a JOIN characters c ON c.id=a.owner_id
      WHERE a.owner_type='character'
    UNION SELECT name, danbooru_tag, 3 FROM works WHERE danbooru_tag IS NOT NULL
    UNION SELECT a.alias, w.danbooru_tag, 3 FROM aliases a JOIN works w ON w.id=a.owner_id
      WHERE a.owner_type='work' AND w.danbooru_tag IS NOT NULL
    UNION SELECT tag, tag, category FROM tag_i18n WHERE category IN (0,3,4)
    UNION SELECT name, name, category FROM danbooru_tags WHERE category IN (0,3,4) AND not_found=0
    UNION SELECT name, name, 0 FROM tags WHERE category='general'
  `).all() as { name: string; tag: string; category: number }[];
  const normalized = new Map<string, string>();
  for (const r of rows) {
    if (r.category === 0) {
      qualifiedGeneral.add(fullKey(r.tag));
      // cosplay 的搜索键已经丢失限定词，不能拿它否定角色本名。
      if (!r.tag.endsWith('_(cosplay)')) general.add(searchKey(r.name));
      continue;
    }
    let tag = r.tag;
    if (r.category === 4) {
      tag = normalized.get(r.tag) ?? (r.tag.startsWith('emaki:character:') ? r.tag : catalog.normalizeTag(r.tag));
      normalized.set(r.tag, tag);
    }
    add(r.category === 4 ? characters : works, r.name, tag);
  }
  return (artwork: PixivArtwork): { tags: string[]; automatic: boolean } => {
    const names = artwork.tags.tags.map((t) => [t.tag, ...Object.values(t.translation ?? {})]);
    const workTags = new Set(names.flatMap((group) => group.flatMap((n) => [...(works.get(searchKey(n)) ?? [])])));
    const matched = new Set<string>();
    let ambiguous = false;
    for (const group of names) {
      // 原文明示普通词或 cosplay 时不认角色；普通译名不能否定明确的原文角色名。
      if (qualifiedGeneral.has(fullKey(group[0]!)) || /\((?:cosplay|コスプレ)\)/i.test(group[0]!.normalize('NFKC')) || general.has(searchKey(group[0]!))) continue;
      const raw = characters.get(searchKey(group[0]!));
      const translations = group.slice(1).filter((n) => !general.has(searchKey(n)) && !qualifiedGeneral.has(fullKey(n)));
      let candidates = new Set(raw?.size ? raw : translations.flatMap((n) => [...(characters.get(searchKey(n)) ?? [])]));
      // 原文同名时，用同一个 Pixiv 标签的译名交叉确认；不同标签仍各自解析。
      if (raw && candidates.size > 1) {
        for (const translated of translations) {
          const translatedTags = characters.get(searchKey(translated));
          if (!translatedTags?.size) continue;
          const narrowed = [...candidates].filter((tag) => translatedTags.has(tag));
          if (narrowed.length) candidates = new Set(narrowed);
        }
      }
      if (candidates.size > 1 && workTags.size) {
        const narrowed = [...candidates].filter((tag) => copyrights.copyrights(tag).some((w) => workTags.has(w)));
        if (narrowed.length) candidates = new Set(narrowed);
      }
      if (candidates.size > 1) ambiguous = true;
      for (const tag of candidates) matched.add(tag);
    }
    // 多个别名命中同一角色，按一个角色计；投稿页数不以本地下载的页数代替。
    return { tags: [...matched], automatic: !ambiguous && (artwork.pageCount === 1 || matched.size === 1) };
  };
}
