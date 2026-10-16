import { searchKey } from '@emaki/shared';
import type { Db } from '../../db/connection.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import type { PixivArtwork } from './client.ts';

type Index = Map<string, Set<string>>;
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
  const rows = db.prepare(`
    SELECT k.search_key AS name, k.tag, COALESCE(d.category, t.category) AS category
    FROM tag_name_keys k LEFT JOIN danbooru_tags d ON d.name=k.tag LEFT JOIN tag_i18n t ON t.tag=k.tag
    WHERE COALESCE(d.category, t.category) IN (0,3,4)
    UNION SELECT name, danbooru_tag, 4 FROM characters WHERE danbooru_tag IS NOT NULL
    UNION SELECT a.alias, c.danbooru_tag, 4 FROM aliases a JOIN characters c ON c.id=a.owner_id
      WHERE a.owner_type='character' AND c.danbooru_tag IS NOT NULL
    UNION SELECT name, danbooru_tag, 3 FROM works WHERE danbooru_tag IS NOT NULL
    UNION SELECT a.alias, w.danbooru_tag, 3 FROM aliases a JOIN works w ON w.id=a.owner_id
      WHERE a.owner_type='work' AND w.danbooru_tag IS NOT NULL
    UNION SELECT tag, tag, category FROM tag_i18n WHERE category IN (0,3,4)
    UNION SELECT name, name, category FROM danbooru_tags WHERE category IN (0,3,4) AND not_found=0
    UNION SELECT name, name, 0 FROM tags WHERE category='general'
  `).all() as { name: string; tag: string; category: number }[];
  const normalized = new Map<string, string>();
  for (const r of rows) {
    if (r.category === 0) { general.add(searchKey(r.name)); continue; }
    let tag = r.tag;
    if (r.category === 4) {
      tag = normalized.get(r.tag) ?? catalog.normalizeTag(r.tag);
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
      // 普通词如 kneesocks 也可能是角色名。原文/译名命中普通标签时不据此认角色。
      if (group.some((n) => general.has(searchKey(n)))) continue;
      const raw = characters.get(searchKey(group[0]!));
      let candidates = new Set(raw?.size ? raw : group.slice(1).flatMap((n) => [...(characters.get(searchKey(n)) ?? [])]));
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
