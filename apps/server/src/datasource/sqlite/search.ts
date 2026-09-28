/**
 * ⌘K 搜索（T20）：角色、作品、标签三类，规则与 mock 一致（searchKey 子串匹配，名额也一样）。
 * 角色 / 作品来自 Derived 缓存；标签用 tags.image_count 缓存（打标签后立即刷新，其他变化防抖 5 秒）。
 */
import { searchKey, type SearchHit, type SearchQuery } from '@emaki/shared';
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
