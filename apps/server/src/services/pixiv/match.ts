import { searchKey, katakanaToHiragana } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { isOriginalArtwork, type PixivArtwork } from './client.ts';

type Index = Map<string, Set<string>>;
const fullKey = (name: string) => katakanaToHiragana(name.normalize('NFKC').toLowerCase().replace(/[\s_\-·・]+/g, ''));
// 只为完整姓名增加免作品标签的通道：分词姓名，或至少四字、含两个汉字的姓名。
// 短名仍走原来的作品校验；限定词不能被搜索归一化丢掉后当作完整姓名。
function isFullName(name: string): boolean {
  const value = name.normalize('NFKC').trim();
  if (/[()]/.test(value)) return false;
  const words = value.split(/[\s_\-·・]+/);
  return (words.length >= 2 && words.every(w => /^\p{L}{2,}$/u.test(w)))
    || (/^\p{L}{4,}$/u.test(value) && (value.match(/\p{Script=Han}/gu)?.length ?? 0) >= 2);
}
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
// search_key 已经丢掉括号和分词信息，完整姓名的证据必须从原始名称读取。
const RAW_NAMES_SQL = `
    SELECT name, COALESCE(danbooru_tag, 'emaki:character:' || id) AS tag FROM characters
    UNION SELECT a.alias, COALESCE(c.danbooru_tag, 'emaki:character:' || c.id)
      FROM aliases a JOIN characters c ON c.id=a.owner_id WHERE a.owner_type='character'
    UNION SELECT tag, tag FROM tag_i18n WHERE category=4
    UNION SELECT zh, tag FROM tag_i18n WHERE category=4 AND zh IS NOT NULL
    UNION SELECT j.value, t.tag FROM tag_i18n t, json_each(CASE WHEN json_valid(t.aliases) THEN t.aliases ELSE '[]' END) j
      WHERE t.category=4 AND j.type='text'
    UNION SELECT name, name FROM danbooru_tags WHERE category=4 AND not_found=0
    UNION SELECT j.value, d.name FROM danbooru_tags d, json_each(CASE WHEN json_valid(d.other_names) THEN d.other_names ELSE '[]' END) j
      WHERE d.category=4 AND d.not_found=0 AND j.type='text'
  `;
type Row = { name: string; tag: string; category: number };
export type PixivMatcher = ((artwork: PixivArtwork) => { tags: string[]; automatic: boolean }) & {
  /** discovery 新写入的标签：只按这些标签补进索引，不全量重建（全量一次一两秒，卡住主线程） */
  refresh(tags: string[]): void;
};

/** 精确匹配名称/别名，不按包含关系猜角色；同名时用投稿里的作品标签消歧。 */
export function createPixivMatcher(db: Db, catalog: CharacterCatalog, copyrights: CopyrightSource): PixivMatcher {
  const characters: Index = new Map();
  const fullNames: Index = new Map();
  const fullNameKeys = new Map<string, Set<string>>();
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
  const ingestFullNames = (rows: { name: string; tag: string }[]) => {
    for (const row of rows) {
      if (!isFullName(row.name)) continue;
      const key = fullKey(row.name);
      const tags = fullNames.get(key) ?? new Set<string>();
      tags.add(row.tag);
      fullNames.set(key, tags);
      const keys = fullNameKeys.get(row.tag) ?? new Set<string>();
      keys.add(key);
      fullNameKeys.set(row.tag, keys);
    }
  };
  ingestFullNames(db.prepare(RAW_NAMES_SQL).all() as { name: string; tag: string }[]);
  // 按标签过滤的同一条查询，SQLite 会把条件下推到每个分支
  let scoped: Statement | undefined;
  let scopedFullNames: Statement | undefined;
  const match = (artwork: PixivArtwork): { tags: string[]; automatic: boolean } => {
    const names = artwork.tags.tags.map((t) => [t.tag, ...Object.values(t.translation ?? {})]);
    const workTags = new Set(names.flatMap((group) => group.flatMap((n) => [...(works.get(searchKey(n)) ?? [])])));
    const matched = new Set<string>();
    const exactNames = new Set<string>();
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
      // 仅认页面原文的完整姓名，不把机器译名或去掉限定词后的搜索命中升级为证据。
      const exact = new Set([...(fullNames.get(fullKey(group[0]!)) ?? [])].map(t => {
        const tag = normalized.get(t) ?? (t.startsWith(CUSTOM) ? t : catalog.normalizeTag(t));
        normalized.set(t, tag);
        return tag;
      }));
      if (candidates.size === 1 && exact.size === 1) {
        const tag = [...candidates][0]!;
        if (exact.has(tag) && isFullName(tag)) exactNames.add(tag);
      }
      for (const tag of candidates) matched.add(tag);
    }
    // 短名仍需作品确认；完整姓名须原文唯一命中，且角色已有作品资料、页面未标其他作品。
    // 自建角色是用户自己起的名字，不用作品确认；Pixiv 标了原创的投稿不自动挂 Danbooru 角色。
    const confirmed = (tag: string) => {
      if (tag.startsWith(CUSTOM)) return true;
      if (isOriginalArtwork(artwork)) return false;
      const knownWorks = copyrights.copyrights(tag);
      return knownWorks.some(w => workTags.has(w))
        || (!workTags.size && knownWorks.length > 0 && exactNames.has(tag));
    };
    // 多个别名命中同一角色，按一个角色计；投稿页数不以本地下载的页数代替。
    return { tags: [...matched], automatic: !ambiguous && (artwork.pageCount === 1 || matched.size === 1) && [...matched].every(confirmed) };
  };
  return Object.assign(match, {
    refresh(tags: string[]) {
      if (!tags.length) return;
      for (const t of tags) {
        normalized.delete(t);
        for (const key of fullNameKeys.get(t) ?? []) {
          const values = fullNames.get(key)!;
          values.delete(t);
          if (!values.size) fullNames.delete(key);
        }
        fullNameKeys.delete(t);
      }
      scoped ??= db.prepare(`SELECT * FROM (${SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingest(scoped.all(JSON.stringify(tags)) as Row[]);
      scopedFullNames ??= db.prepare(`SELECT * FROM (${RAW_NAMES_SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingestFullNames(scopedFullNames.all(JSON.stringify(tags)) as { name: string; tag: string }[]);
    },
  });
}
