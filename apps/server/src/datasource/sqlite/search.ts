import { performance } from 'node:perf_hooks';
/**
 * ⌘K 搜索（T20）：角色、作品、标签三类，规则：searchKey 子串匹配，每类有名额。标签也按中文名和别名搜。
 * 角色 / 作品来自 Derived 缓存；标签用 tags.image_count 缓存（图库有变化只标记过期，下次搜索时再刷新）。
 */
import {
  searchKey,
  TAG_FILTER_MIN_SCORE,
  type SearchHit,
  type SearchQuery,
  type TagPhraseResponse,
  type TagSuggestion,
  type TagSuggestionsQuery,
} from '@emaki/shared';
import { stripZhQualifier } from '../../services/i18n/humanize.ts';
import { buildPhraseDict, parseTagPhrase, type PhraseDict } from '../../services/search/tagPhrase.ts';
import type { Db } from '../../db/connection.ts';
import type { CharacterCatalog } from '../../domain/catalog/characterCatalog.ts';
import { ASSIGN_CANDIDATES_KEY } from '../../propagation/cacheScope.ts';
import type { Derived } from './derived.ts';
import { toCharacter, toWork } from './library.ts';

import { refreshTagCounts } from '../../domain/evidence/tagCounts.ts';

export { refreshTagCounts };

export interface SearchOptions {
  /**
   * 后台任务写库让标签张数过期时，距上次重数不到这么久就继续用旧的（重数一次要沿 300 多万行的索引走一遍，约半秒；
   * 这个数只用来挑候选和 ⌘K 里标签那一行的张数，联想里显示的张数另外现数）。不给 = 不等
   */
  countsSoftMs?: () => number;
  /** 结果缓存（SqliteDataSource.results）里的一格：归类弹窗的候选放这里，什么时候失效见 propagation/cacheScope.ts。不给 = 每次现算 */
  cached?: <T>(key: string, compute: () => T) => T;
}

export class SearchQueries {
  /** 标签联想用：库里有的一般标签 + 中文名 / 别名的搜索键 */
  private suggest: SuggestEntry[] | null = null;
  /** 一句话拆标签用的词库（和 suggest 一起失效） */
  private phraseDict: { dict: PhraseDict; byTag: Map<string, SuggestEntry> } | null = null;
  /** tags.image_count 过期了（进程刚启动也算）：下次搜索 / 联想时同步刷新一次 */
  private stale = true;
  /** 后台任务写库引起的过期：过了 countsSoftMs 才重数 */
  private softStale = false;
  private refreshedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly derived: Derived,
    private readonly opts: SearchOptions = {},
  ) {}

  refreshNow(): void {
    refreshTagCounts(this.db);
    this.stale = false;
    this.softStale = false;
    this.refreshedAt = performance.now();
    this.dropKeys();
  }

  /**
   * 搜索键（标签名、中文名、别名）和已经数过的达标张数：每次有写入都清，下次用到时重建（一条一万多行的查询）。
   * 中文词库换了也要重建，而词库的导入不一定声明变化，所以不按变化类型挑
   */
  dropKeys(): void {
    this.suggest = null;
    this.phraseDict = null;
  }

  /**
   * 标签张数过期了：图的标签变了（识别），或者图计不计入变了（排除、回收站、丢失、文件夹停用）。只记一笔，等真的搜索时再重数。
   * 收藏、分级、归类、放下都改不到它，不会走到这里（propagation/cacheScope.ts）。
   * 不用计时器在后台刷：重数是同步的，扫描 / 识别期间每几秒一次会让整个服务一次卡半秒以上；
   * 后台任务引起的（soft）另有时间窗，见 SearchOptions.countsSoftMs
   */
  markCountsStale(soft = false): void {
    if (soft) this.softStale = true;
    else this.stale = true;
  }

  /** 后台任务结束：软过期的张数下次一定重数 */
  settleSoft(): void {
    if (this.softStale) this.stale = true;
  }

  private suggestEntries(): SuggestEntry[] {
    if (this.stale || (this.softStale && performance.now() - this.refreshedAt >= (this.opts.countsSoftMs?.() ?? 0))) this.refreshNow();
    this.suggest ??= (
      this.db
        .prepare(
          `SELECT t.id, t.name, t.image_count, i.zh, i.aliases FROM tags t LEFT JOIN tag_i18n i ON i.tag = t.name
           WHERE t.category = 'general' AND t.image_count > 0`,
        )
        .all() as { id: number; name: string; image_count: number; zh: string | null; aliases: string | null }[]
    ).map((t) => {
      const zh = t.zh ? stripZhQualifier(t.zh) : null;
      let aliases: string[] = [];
      try {
        aliases = t.aliases ? (JSON.parse(t.aliases) as string[]) : [];
      } catch {
        /* 词库坏了就只用标签名 */
      }
      const primary = [...new Set([t.name, ...(zh ? [zh] : [])].map(searchKey).filter(Boolean))];
      const alias = [...new Set(aliases.map(searchKey).filter((k) => k && !primary.includes(k)))];
      return { id: t.id, tag: t.name, name: zh ?? t.name.replace(/_/g, ' '), keys: [...primary, ...alias], primary, alias, cached: t.image_count };
    });
    return this.suggest;
  }

  /**
   * 一般标签联想（自定义画面）：标签名、中文名、别名子串匹配。
   * 先按缓存的 image_count 挑出 limit 个候选（完全匹配优先），再只给这几个数分数达标的张数
   * （走 idx_image_tags_tag_score，不回表。索引里分不出已排除 / 回收站的图，所以再和 image_count 取小；
   * 联 v_counted_images 精确计数在大库上要 1 秒以上，不值得）。
   */
  tagSuggestions(query: TagSuggestionsQuery): TagSuggestion[] {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const k = searchKey(query.q?.trim() ?? '');
    const rank = (e: SuggestEntry) => (!k ? 2 : e.keys.includes(k) ? 0 : e.keys.some((x) => x.startsWith(k)) ? 1 : 2);
    const picked = this.suggestEntries()
      .filter((e) => !k || e.keys.some((x) => x.includes(k)))
      .map((e) => ({ e, r: rank(e) }))
      .sort((a, b) => a.r - b.r || b.e.cached - a.e.cached || a.e.tag.localeCompare(b.e.tag))
      .slice(0, limit);
    return picked
      .map(({ e, r }) => ({ r, s: { tag: e.tag, name: e.name, count: this.scored(e) } }))
      .filter((x) => x.s.count > 0)
      .sort((a, b) => Number(b.r === 0) - Number(a.r === 0) || b.s.count - a.s.count || a.s.tag.localeCompare(b.s.tag))
      .map((x) => x.s);
  }

  /** 分数达标的张数（走 idx_image_tags_tag_score，不回表；索引里分不出已排除 / 回收站的图，所以再和 image_count 取小） */
  private scored(e: SuggestEntry): number {
    e.scored ??= Math.min(
      this.db.prepare('SELECT COUNT(*) FROM image_tags WHERE tag_id = ? AND score >= ?').pluck().get(e.id, TAG_FILTER_MIN_SCORE) as number,
      e.cached,
    );
    return e.scored;
  }

  /**
   * 一句话拆成标签（图库搜索框的「按标签」）：只认分数达标的张数 > 0 的一般标签。
   * total 由调用方数（和图库「必含」同一个查询），一个标签都没认出时不数
   */
  tagPhrase(q: string, total: (tags: string[]) => number): TagPhraseResponse {
    const entries = this.suggestEntries();
    this.phraseDict ??= {
      dict: buildPhraseDict(entries.map((e) => ({ tag: e.tag, primary: e.primary, aliases: e.alias, count: e.cached }))),
      byTag: new Map(entries.map((e) => [e.tag, e])),
    };
    const { dict, byTag } = this.phraseDict;
    const has = (tag: string) => {
      const e = byTag.get(tag);
      return !!e && this.scored(e) > 0;
    };
    const { tags, rest } = parseTagPhrase(q, dict, has);
    return {
      tags: tags.map((t) => {
        const e = byTag.get(t)!;
        return { tag: e.tag, name: e.name, count: this.scored(e) };
      }),
      rest,
      total: tags.length ? total(tags) : 0,
    };
  }

  /**
   * 归类弹窗里还没建档的候选：证据里有、但对不上任何角色的标签，带张数和可以搜到它的名字。
   * 和搜的词无关，整份放进结果缓存：现算要对每个标签查一遍角色、作品、别名（真实库约 0.2 秒），而弹窗里每敲一个字就是一个请求。
   * 顺序是标签名的顺序（同一个规范化标签有几个写法时，并列的取先出现的）
   */
  private assignCandidates(catalog: CharacterCatalog): AssignCandidate[] {
    const compute = (): AssignCandidate[] => {
      const tags = this.db.prepare(`
        SELECT s.danbooru_tag AS tag, COUNT(*) AS count
        FROM v_character_suggestions s JOIN v_counted_images i ON i.id=s.image_id
        WHERE s.character_id IS NULL AND s.danbooru_tag NOT LIKE 'emaki:%'
        GROUP BY s.danbooru_tag
      `).all() as { tag: string; count: number }[];
      const out: AssignCandidate[] = [];
      for (const { tag, count } of tags) {
        if (catalog.resolveCharacterId(tag) !== null) continue;
        const canonical = catalog.normalizeTag(tag);
        const { name, workName } = catalog.describeTag(tag);
        const names = catalog.namesForTag(canonical, name);
        if (canonical !== tag) names.push(tag);
        out.push({ tag, count, canonical, name, workName, workKey: workName ? searchKey(workName) : null, names, keys: names.map(searchKey) });
      }
      return out;
    };
    return this.opts.cached ? this.opts.cached(ASSIGN_CANDIDATES_KEY, compute) : compute();
  }

  search(query: SearchQuery, catalog?: CharacterCatalog): SearchHit[] {
    const limit = query.limit ?? 20;
    const k = searchKey(query.q.trim());
    if (!k) return [];
    const d = this.derived.get();
    const byCount = <T extends { imageCount: number; id: number }>(a: T, b: T) => b.imageCount - a.imageCount || a.id - b.id;
    if (query.forAssignment && catalog) {
      const rankKey = (key: string) => {
        return key === k ? 0 : key.startsWith(k) ? 1 : key.includes(k) ? 2 : 3;
      };
      type Match = { hit: SearchHit; rank: number; count: number };
      const rows: Match[] = [];
      for (const c of d.characters.values()) {
        const nameRank = Math.min(...c.nameKeys.map(rankKey));
        const workName = d.works.get(c.workIds[0] ?? -1)?.name ?? null;
        if (nameRank < 3 || c.keys.some(key => key.includes(k))) rows.push({
          hit: { type: 'character', character: toCharacter(c), workName }, rank: nameRank, count: c.imageCount,
        });
      }
      const candidates = new Map<string, Match>();
      for (const { tag, count, canonical, name, workName, workKey, names, keys } of this.assignCandidates(catalog)) {
        const ranks = keys.map(rankKey);
        const best = Math.min(...ranks);
        if (best === 3 && (workKey === null || rankKey(workKey) === 3)) continue;
        // 命中的别的名字里排得最靠前的那个（并列取先出现的）
        let matched = -1;
        names.forEach((n, i) => {
          if (n !== name && ranks[i]! < 3 && (matched < 0 || ranks[i]! < ranks[matched]!)) matched = i;
        });
        const matchedName = matched < 0 ? undefined : names[matched];
        const prev = candidates.get(canonical);
        if (prev && prev.rank <= best) { prev.count += count; continue; }
        candidates.set(canonical, {
          hit: { type: 'characterCandidate', danbooruTag: tag, name, workName, ...(matchedName ? { matchedName } : {}) },
          rank: best, count: count + (prev?.count ?? 0),
        });
      }
      rows.push(...candidates.values());
      return rows.sort((a, b) => a.rank - b.rank || Number(b.hit.type === 'character') - Number(a.hit.type === 'character') || b.count - a.count)
        .slice(0, limit).map(row => row.hit);
    }
    // 给作品和标签各留名额，角色很多时它们也不会整组消失
    const chars: SearchHit[] = [...d.characters.values()]
      .filter((c) => c.keys.some((x) => x.includes(k)))
      .sort(byCount)
      .slice(0, Math.max(limit - 6, Math.ceil(limit / 2)))
      .map((c) => ({ type: 'character', character: toCharacter(c), workName: d.works.get(c.workIds[0] ?? -1)?.name ?? null }));
    const works: SearchHit[] = [...d.works.values()]
      .filter((w) => w.keys.some((x) => x.includes(k)))
      .sort(byCount)
      .slice(0, 3)
      .map((w) => ({ type: 'work', work: toWork(w) }));
    // 标签名、中文名、别名都算；完全对上的排前面（搜「黑发」先出 black_hair，再出 black_hair 开头的长尾）
    const rank = (e: SuggestEntry) => (e.keys.includes(k) ? 0 : 1);
    const tags: SearchHit[] = this.suggestEntries()
      .filter((e) => e.keys.some((x) => x.includes(k)))
      .sort((a, b) => rank(a) - rank(b) || b.cached - a.cached || a.tag.localeCompare(b.tag))
      .slice(0, 3)
      .map((e) => ({ type: 'tag', tag: e.tag, name: e.name, imageCount: e.cached }));
    return [...chars, ...works, ...tags].slice(0, limit);
  }
}

interface AssignCandidate {
  tag: string;
  /** 有这条证据的图数 */
  count: number;
  /** 规范化之后的标签（改名、服装变体归到同一个） */
  canonical: string;
  name: string;
  workName: string | null;
  /** searchKey(workName) */
  workKey: string | null;
  /** 可以搜到它的名字：显示名、标签、别名 */
  names: string[];
  /** names 各自的 searchKey */
  keys: string[];
}

interface SuggestEntry {
  id: number;
  tag: string;
  /** 显示名：中文名（去掉结尾括号）或把下划线换成空格 */
  name: string;
  /** 标签名 / 中文名 / 别名的 searchKey */
  keys: string[];
  /** 其中标签名和中文名的 */
  primary: string[];
  /** 其中别名的（不含和 primary 重复的） */
  alias: string[];
  /** 分数达标的张数，第一次用到时才数（和缓存一起失效） */
  scored?: number;
  /** tags.image_count（不看分数），只用来挑候选 */
  cached: number;
}
