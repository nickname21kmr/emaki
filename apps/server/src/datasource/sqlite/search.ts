/**
 * ⌘K 搜索（T20）：角色、作品、标签三类，规则与 mock 一致（searchKey 子串匹配，名额也一样）。
 * 角色 / 作品来自 Derived 缓存；标签用 tags.image_count 缓存（打标签后立即刷新，其他变化防抖 5 秒）。
 */
import { searchKey, TAG_FILTER_MIN_SCORE, type SearchHit, type SearchQuery, type TagSuggestion, type TagSuggestionsQuery } from '@emaki/shared';
import { stripZhQualifier } from '../../services/i18n/humanize.ts';
import type { Db } from '../../db/connection.ts';
import type { Derived } from './derived.ts';
import { toCharacter, toWork } from './library.ts';

export function refreshTagCounts(db: Db): void {
  db.transaction(() => {
    db.prepare('UPDATE tags SET image_count = 0 WHERE image_count <> 0').run();
    db.prepare(
      `UPDATE tags SET image_count = c.n
       FROM (SELECT it.tag_id, COUNT(*) AS n
             FROM image_tags it JOIN v_counted_images i ON i.id = it.image_id
             GROUP BY it.tag_id) AS c
       WHERE c.tag_id = tags.id`,
    ).run();
  })();
}

const DEBOUNCE_MS = 5000;

export class SearchQueries {
  private tags: { name: string; key: string; count: number }[] | null = null;
  /** 标签联想用：库里有的一般标签 + 中文名 / 别名的搜索键（和 tags 一起失效） */
  private suggest: SuggestEntry[] | null = null;
  /** 本进程还没刷新过：第一次搜索时同步刷新一次 */
  private fresh = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly derived: Derived,
  ) {}

  refreshNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    refreshTagCounts(this.db);
    this.fresh = true;
    this.tags = null;
    this.suggest = null;
  }

  /** 图库有变化（排除、回收站、扫描……）：合并成一次刷新 */
  scheduleRefresh(): void {
    if (!this.fresh || this.timer) return;
    this.timer = setTimeout(() => this.refreshNow(), DEBOUNCE_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private generalTags() {
    if (!this.fresh) this.refreshNow();
    this.tags ??= (
      this.db.prepare("SELECT name, image_count FROM tags WHERE category = 'general' AND image_count > 0").all() as {
        name: string;
        image_count: number;
      }[]
    ).map((t) => ({ name: t.name, key: searchKey(t.name), count: t.image_count }));
    return this.tags;
  }

  private suggestEntries(): SuggestEntry[] {
    if (!this.fresh) this.refreshNow();
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
      const keys = [...new Set([t.name, ...(zh ? [zh] : []), ...aliases].map(searchKey).filter(Boolean))];
      return { id: t.id, tag: t.name, name: zh ?? t.name.replace(/_/g, ' '), keys, cached: t.image_count };
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
    const count = this.db.prepare('SELECT COUNT(*) FROM image_tags WHERE tag_id = ? AND score >= ?').pluck();
    return picked
      .map(({ e, r }) => {
        e.scored ??= Math.min(count.get(e.id, TAG_FILTER_MIN_SCORE) as number, e.cached);
        return { r, s: { tag: e.tag, name: e.name, count: e.scored } };
      })
      .filter((x) => x.s.count > 0)
      .sort((a, b) => Number(b.r === 0) - Number(a.r === 0) || b.s.count - a.s.count || a.s.tag.localeCompare(b.s.tag))
      .map((x) => x.s);
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
    const tags: SearchHit[] = this.generalTags()
      .filter((t) => t.key.includes(k))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((t) => ({ type: 'tag', tag: t.name, imageCount: t.count }));
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
  /** 分数达标的张数，第一次用到时才数（和缓存一起失效） */
  scored?: number;
  /** tags.image_count（不看分数），只用来挑候选 */
  cached: number;
}
