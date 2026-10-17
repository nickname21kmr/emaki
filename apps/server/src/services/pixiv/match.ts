import { searchKey, katakanaToHiragana } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
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

const CUSTOM = 'emaki:character:';
const SQL = `
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
  `;
type Row = { name: string; tag: string; category: number };
export type PixivMatcher = ((artwork: PixivArtwork) => { tags: string[]; automatic: boolean }) & {
  /** discovery 新写入的标签：只按这些标签补进索引，不全量重建（全量一次一两秒，卡住主线程） */
  refresh(tags: string[]): void;
};

/** 精确匹配名称/别名，不按包含关系猜角色；同名时用投稿里的作品标签消歧。 */
export function createPixivMatcher(db: Db, catalog: CharacterCatalog, copyrights: CopyrightSource): PixivMatcher {
  const characters: Index = new Map();
  const works: Index = new Map();
  const general = new Set<string>();
  const qualifiedGeneral = new Set<string>();
  const normalized = new Map<string, string>();
  const ingest = (rows: Row[]) => {
    for (const r of rows) {
      if (r.category === 0) {
        qualifiedGeneral.add(fullKey(r.tag));
        // cosplay 的搜索键已经丢失限定词，不能拿它否定角色本名。
        if (!r.tag.endsWith('_(cosplay)')) general.add(searchKey(r.name));
        continue;
      }
      let tag = r.tag;
      if (r.category === 4) {
        tag = normalized.get(r.tag) ?? (r.tag.startsWith(CUSTOM) ? r.tag : catalog.normalizeTag(r.tag));
        normalized.set(r.tag, tag);
      }
      add(r.category === 4 ? characters : works, r.name, tag);
    }
  };
  ingest(db.prepare(SQL).all() as Row[]);
  // 按标签过滤的同一条查询，SQLite 会把条件下推到每个分支
  let scoped: Statement | undefined;
  const match = (artwork: PixivArtwork): { tags: string[]; automatic: boolean } => {
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
    // 常用词会按去掉括号的名字撞上别的作品的角色：只有投稿里的作品标签能确认的才自动关联。
    // 自建角色是用户自己起的名字，不用作品确认；Pixiv 标了原创的投稿不自动挂 Danbooru 角色。
    const confirmed = (tag: string) => tag.startsWith(CUSTOM)
      || (!artwork.isOriginal && copyrights.copyrights(tag).some((w) => workTags.has(w)));
    // 多个别名命中同一角色，按一个角色计；投稿页数不以本地下载的页数代替。
    return { tags: [...matched], automatic: !ambiguous && (artwork.pageCount === 1 || matched.size === 1) && [...matched].every(confirmed) };
  };
  return Object.assign(match, {
    refresh(tags: string[]) {
      if (!tags.length) return;
      for (const t of tags) normalized.delete(t);
      scoped ??= db.prepare(`SELECT * FROM (${SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingest(scoped.all(JSON.stringify(tags)) as Row[]);
    },
  });
}
