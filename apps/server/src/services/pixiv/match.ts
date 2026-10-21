import { searchKey, katakanaToHiragana } from '@emaki/shared';
import type { Db, Statement } from '../../db/connection.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { isOriginalArtwork, type PixivArtwork } from './client.ts';

type Index = Map<string, Set<string>>;
const fullKey = (name: string) => katakanaToHiragana(name.normalize('NFKC').toLowerCase().replace(/[\s_\-·・]+/g, ''));
// 井ノ上 / 井の上 / 井上这类连接字写法；只省略两个汉字之间的「の」。
const nameVariantKey = (key: string) => key.replace(/(\p{Script=Han})の(?=\p{Script=Han})/gu, '$1');
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
const RAW_WORK_NAMES_SQL = `
    SELECT j.value AS name,t.tag,3 AS category FROM tag_i18n t,json_each(CASE WHEN json_valid(t.aliases) THEN t.aliases ELSE '[]' END) j
      WHERE t.category=3 AND j.type='text'
    UNION SELECT zh,tag,3 FROM tag_i18n WHERE category=3 AND zh IS NOT NULL
    UNION SELECT j.value,d.name,3 FROM danbooru_tags d,json_each(CASE WHEN json_valid(d.other_names) THEN d.other_names ELSE '[]' END) j
      WHERE d.category=3 AND d.not_found=0 AND j.type='text'
  `;
type Row = { name: string; tag: string; category: number };
export type PixivMatcher = ((artwork: PixivArtwork) => { tags: string[]; automatic: boolean }) & {
  /** discovery 新写入的标签：只按这些标签补进索引，不全量重建（全量一次一两秒，卡住主线程） */
  refresh(tags: string[]): void;
};

/** 优先精确匹配名称/别名，作品内补充连接字变体；不按包含关系猜角色，同名时用作品消歧。 */
export function createPixivMatcher(db: Db, catalog: CharacterCatalog, copyrights: CopyrightSource): PixivMatcher {
  const characters: Index = new Map();
  const fullNames: Index = new Map();
  const nameVariants: Index = new Map();
  const fullNameKeys = new Map<string, Set<string>>();
  const works: Index = new Map();
  const general = new Set<string>();
  const qualifiedGeneral = new Set<string>();
  const normalized = new Map<string, string>();
  const normalizeTag = (tag: string) => {
    const value = normalized.get(tag) ?? (tag.startsWith(CUSTOM) ? tag : catalog.normalizeTag(tag));
    normalized.set(tag, value);
    return value;
  };
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
        tag = normalizeTag(r.tag);
      }
      if (r.category === 4) add(characters, r.name, tag);
      else {
        const key = fullKey(r.name);
        const tags = works.get(key) ?? new Set<string>();
        tags.add(tag); works.set(key,tags);
      }
    }
  };
  ingest(db.prepare(SQL).all() as Row[]);
  ingest(db.prepare(RAW_WORK_NAMES_SQL).all() as Row[]);
  const ingestFullNames = (rows: { name: string; tag: string }[]) => {
    for (const row of rows) {
      const key = fullKey(row.name);
      const tags = fullNames.get(key) ?? new Set<string>();
      tags.add(row.tag);
      fullNames.set(key, tags);
      const variant = nameVariantKey(key);
      if (variant !== key && isFullName(row.name)) {
        const variants = nameVariants.get(variant) ?? new Set<string>();
        variants.add(row.tag);
        nameVariants.set(variant, variants);
      }
      const keys = fullNameKeys.get(row.tag) ?? new Set<string>();
      keys.add(key);
      fullNameKeys.set(row.tag, keys);
    }
  };
  ingestFullNames(db.prepare(RAW_NAMES_SQL).all() as { name: string; tag: string }[]);
  // 按标签过滤的同一条查询，SQLite 会把条件下推到每个分支
  let scoped: Statement | undefined;
  let scopedFullNames: Statement | undefined;
  let scopedWorkNames: Statement | undefined;
  const identities = (name: string) => new Set([...(fullNames.get(fullKey(name)) ?? [])].map(normalizeTag));
  // 作品的子系列、歌曲等可确认父作品，但不反向展开成所有子作品。
  const expandWorks = (tags: Iterable<string>): Set<string> => {
    const out = new Set(tags);
    let frontier = [...out];
    for (let depth=0;depth<5 && frontier.length;depth++) {
      const next: string[] = [];
      for (const tag of frontier) {
        const qualifier = /_\(([^()]+)\)$/.exec(tag)?.[1];
        const parents = [...(copyrights.impliesClosure?.(tag) ?? []), ...(qualifier ? works.get(fullKey(qualifier)) ?? [] : [])];
        for (const parent of parents) if (!out.has(parent) && works.get(fullKey(parent))?.has(parent)) {
          out.add(parent); next.push(parent);
        }
      }
      frontier = next;
    }
    return out;
  };
  const match = (artwork: PixivArtwork): { tags: string[]; automatic: boolean } => {
    const names = artwork.tags.tags.map((t) => [t.tag, ...Object.values(t.translation ?? {})]);
    const workTags = expandWorks(names.flatMap(group => {
      const raw = group[0]!;
      if (general.has(searchKey(raw))) return [];
      const direct = works.get(fullKey(raw));
      if (direct?.size) return [...direct];
      if (characters.has(searchKey(raw))) return [];
      // 译名同时是角色短名时，不把它凭空变成作品上下文。
      return group.slice(1).filter(n => !characters.has(searchKey(n))).flatMap(n => [...(works.get(fullKey(n)) ?? [])]);
    }));
    const matched = new Set<string>();
    const exactNames = new Set<string>();
    const qualifiedNames = new Set<string>();
    let ambiguous = false;
    let unresolved = false;
    for (const group of names) {
      const original = group[0]!;
      // 原文明示普通词或 cosplay 时不认角色；普通译名不能否定明确的原文角色名。
      if (/^R-18(?:G)?$/i.test(original) || works.has(fullKey(original)) || qualifiedGeneral.has(fullKey(original)) || /\((?:cosplay|コスプレ)\)/i.test(original.normalize('NFKC')) || general.has(searchKey(original))) continue;
      const qualifier = /\(([^()]+)\)$/.exec(original.normalize('NFKC'))?.[1];
      const scope = qualifier ? expandWorks(works.get(fullKey(qualifier)) ?? []) : workTags;
      const strict = identities(original);
      const compatible = (tag: string) => tag.startsWith(CUSTOM) || copyrights.copyrights(tag).some(w => scope.has(w));
      let raw = qualifier && strict.size ? strict : characters.get(searchKey(original));
      if (qualifier && !strict.size && !scope.size) {
        if (raw?.size || group.slice(1).some(n => characters.has(searchKey(n)))) unresolved = true;
        continue;
      }
      // 例如「ビンタ」译为 slap：没有相应作品依据时，它是普通动作，不是同名角色。
      if (group.slice(1).some(n => general.has(searchKey(n))) && !isFullName(original)
        && ![...(raw ?? [])].some(compatible)) continue;
      // 精确原文未命中时，才在同一作品内找完整姓名的连接字变体。
      // 不以译名、任意编辑距离或同投稿其他图片的角色替代原文身份依据。
      if (!raw?.size && workTags.size && !isOriginalArtwork(artwork) && isFullName(group[0]!)) {
        const key = fullKey(group[0]!);
        const variant = nameVariantKey(key);
        const alternatives = new Set([
          ...(nameVariants.get(variant) ?? []),
          ...(variant !== key ? fullNames.get(variant) ?? [] : []),
        ].map(normalizeTag).filter(tag => copyrights.copyrights(tag).some(work => workTags.has(work))));
        if (alternatives.size) raw = alternatives;
      }
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
      if (scope.size) {
        const narrowed = [...candidates].filter(compatible);
        // 完整原文姓名可以是跨作品图集中的另一人物；短名、译名和丢掉限定词的命中须符合上下文。
        if (narrowed.length || !(strict.size === 1 && raw?.size === 1 && !qualifier)) {
          if (!narrowed.length && candidates.size && (qualifier || raw?.size === 1)) unresolved = true;
          candidates = new Set(narrowed);
        }
      }
      // 普通描述的译名同时命中多个角色，没有原文身份或作品依据时不展开同名目录。
      if (!raw?.size && !scope.size && candidates.size > 1) continue;
      if (candidates.size > 1) ambiguous = true;
      // 仅认页面原文的完整姓名，不把机器译名或去掉限定词后的搜索命中升级为证据。
      if (candidates.size === 1 && strict.size === 1) {
        const tag = [...candidates][0]!;
        if (strict.has(tag) && isFullName(original) && isFullName(tag)) exactNames.add(tag);
        if (strict.has(tag) && qualifier) qualifiedNames.add(tag);
      }
      if (qualifier && scope.size && candidates.size === 1) {
        qualifiedNames.add([...candidates][0]!);
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
        || (knownWorks.length > 0 && qualifiedNames.has(tag))
        || (!workTags.size && knownWorks.length > 0 && exactNames.has(tag));
    };
    // 多个别名命中同一角色，按一个角色计；投稿页数不以本地下载的页数代替。
    return { tags: [...matched], automatic: matched.size > 0 && !ambiguous && !unresolved && (artwork.pageCount === 1 || matched.size === 1) && [...matched].every(confirmed) };
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
          const variant = nameVariantKey(key);
          const variants = nameVariants.get(variant);
          variants?.delete(t);
          if (!variants?.size) nameVariants.delete(variant);
        }
        fullNameKeys.delete(t);
      }
      scoped ??= db.prepare(`SELECT * FROM (${SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingest(scoped.all(JSON.stringify(tags)) as Row[]);
      scopedWorkNames ??= db.prepare(`SELECT * FROM (${RAW_WORK_NAMES_SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingest(scopedWorkNames.all(JSON.stringify(tags)) as Row[]);
      scopedFullNames ??= db.prepare(`SELECT * FROM (${RAW_NAMES_SQL}) WHERE tag IN (SELECT value FROM json_each(?))`);
      ingestFullNames(scopedFullNames.all(JSON.stringify(tags)) as { name: string; tag: string }[]);
    },
  });
}
