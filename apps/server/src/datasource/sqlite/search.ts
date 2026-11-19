/**
 * ⌘K 搜索（T20）：角色、作品、标签三类，searchKey 子串匹配，每类有名额。标签也按中文名和别名搜。
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
import type { Derived } from './derived.ts';
import { toCharacter, toWork } from './library.ts';

/**
 * tags.image_count = 每个标签在计入张数的图（v_counted_images）里出现几次。
 * 不从图出发联 image_tags 再分组（330 万行进临时 B 树，真实库 3.5–6 秒）：
 * 先沿 idx_image_tags_tag_score 按 tag_id 顺序数总数，再减去不计数的图（排除、回收站、丢失、文件夹停用，几千张）的标签。
 * 只写张数变了的行。真实库约 0.6–1 秒，结果和原来逐个一致
 */
export function refreshTagCounts(db: Db): void {
  db.transaction(() => {
    const n = new Map<number, number>();
    for (const [id, c] of db.prepare('SELECT tag_id, COUNT(*) FROM image_tags INDEXED BY idx_image_tags_tag_score GROUP BY tag_id').raw().all() as [
      number,
      number,
    ][]) {
      n.set(id, c);
    }
    // 条件是 v_images + excluded_by IS NULL 的反面；LEFT JOIN 是为了文件夹行不在的图也算不计数（视图里是内连接）
    for (const [id, c] of db
      .prepare(
        `SELECT it.tag_id, COUNT(*) FROM images i LEFT JOIN library_roots r ON r.id = i.root_id
         CROSS JOIN image_tags it ON it.image_id = i.id
         WHERE NOT (r.id IS NOT NULL AND r.enabled = 1 AND r.removed_at IS NULL
                    AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL)
         GROUP BY it.tag_id`,
      )
      .raw()
      .all() as [number, number][]) {
      n.set(id, (n.get(id) ?? 0) - c);
    }
    const update = db.prepare('UPDATE tags SET image_count = ? WHERE id = ?');
    for (const [id, cur] of db.prepare('SELECT id, image_count FROM tags').raw().all() as [number, number][]) {
      const v = n.get(id) ?? 0;
      if (v !== cur) update.run(v, id);
    }
  })();
}

export class SearchQueries {
  /** 标签联想用：库里有的一般标签 + 中文名 / 别名的搜索键 */
  private suggest: SuggestEntry[] | null = null;
  /** 一句话拆标签用的词库（和 suggest 一起失效） */
  private phraseDict: { dict: PhraseDict; byTag: Map<string, SuggestEntry> } | null = null;
  /** tags.image_count 过期了（进程刚启动也算）：下次搜索 / 联想时同步刷新一次 */
  private stale = true;

  constructor(
    private readonly db: Db,
    private readonly derived: Derived,
  ) {}

  refreshNow(): void {
    refreshTagCounts(this.db);
    this.stale = false;
    this.suggest = null;
    this.phraseDict = null;
  }

  /**
   * 图库有变化（排除、回收站、扫描、识别……）：只记一笔，等真的搜索时再刷新。
   * 不用计时器在后台刷：刷新是同步的，扫描 / 识别期间每几秒一次会让整个服务一次卡一秒以上
   */
  markStale(): void {
    this.stale = true;
    this.suggest = null;
    this.phraseDict = null;
  }

  private suggestEntries(): SuggestEntry[] {
    if (this.stale) this.refreshNow();
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

  search(query: SearchQuery): SearchHit[] {
    const limit = query.limit ?? 20;
    const k = searchKey(query.q.trim());
    if (!k) return [];
    const d = this.derived.get();
    const byCount = <T extends { imageCount: number; id: number }>(a: T, b: T) => b.imageCount - a.imageCount || a.id - b.id;
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
