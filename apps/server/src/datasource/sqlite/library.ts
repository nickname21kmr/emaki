/**
 * T13：统计、作品、角色的查询。排序 / 过滤 / 分页逐行对照 MockDataSource。
 */
import {
  CONTENT_KINDS,
  searchKey,
  type ContentKind,
  type ContentKindSummary,
  type Character,
  type CharacterSource,
  type CoverCandidatesResponse,
  type GetCharacterResponse,
  type LibraryStats,
  type ListCharactersQuery,
  type ListCharactersResponse,
  type ListWorksQuery,
  type TopCharactersQuery,
  type Work,
} from '@emaki/shared';
import type { SqliteContext } from './context.ts';
import { COVER_CANDIDATE_COLS, loadCoverTags, scoreCoverCandidates, type CharacterRec, type CoverCandidate, type Derived, type WorkRec } from './derived.ts';
import { loadImageItems } from './hydrate.ts';
import { ART_KINDS_SQL, IN_COMIC_I, DAY, LIVE_IMAGES, DEFAULT_DOMINANT, iso, paginateOffset, parseId, QUEUE, RECENT_DAYS, toId, UNRECOGNIZED, UNTAGGED_UNRECOGNIZED } from './sql.ts';

const zhCollator = new Intl.Collator('zh');

export function toCharacter(r: CharacterRec): Character {
  return {
    id: toId(r.id),
    name: r.name,
    danbooruTag: r.danbooruTag,
    source: r.source,
    aliases: r.aliases,
    workIds: r.workIds.map(toId),
    imageCount: r.imageCount,
    otherCount: r.otherCount,
    newCount: r.newCount,
    coverImageId: r.effectiveCoverId === null ? null : toId(r.effectiveCoverId),
    coverRating: r.coverRating,
    coverFocus: r.coverFocus,
    coverManual: r.coverManual,
    coverColor: r.coverColor,
    recentCount: r.recentCount,
    lastAddedAt: r.lastAddedAt,
    pinned: r.pinned,
  };
}

export function toWork(w: WorkRec): Work {
  return {
    id: toId(w.id),
    name: w.name,
    danbooruTag: w.danbooruTag,
    aliases: w.aliases,
    characterCount: w.characterCount,
    imageCount: w.imageCount,
    otherCount: w.otherCount,
    recentImageCount: w.recentImageCount,
    coverImageId: w.coverImageId === null ? null : toId(w.coverImageId),
    coverRating: w.coverRating,
    color: w.color,
    covers: w.covers.map((c) => ({ ...c, imageId: toId(c.imageId) })),
    coverColor: w.coverColor,
  };
}

/** 识别器自动建、用户没动过、现在一张图（含漫画等）都没有的角色 */
const emptyAuto = (c: CharacterRec) => c.imageCount === 0 && c.otherCount === 0 && c.source === 'danbooru' && !c.nameLocked && !c.pinned;

/** 按 id 升序排好（之后用稳定排序，并列就保持 id 顺序） */
const byId = <T extends { id: number }>(xs: Iterable<T>) => [...xs].sort((a, b) => a.id - b.id);

export class LibraryQueries {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly derived: Derived,
    /** 合集的本数和待整理条目数（T38c，由 CollectionQueries 提供） */
    private readonly collectionStats: () => Pick<LibraryStats, 'collectionCounts' | 'pendingCollectionCount'> = () => ({
      collectionCounts: { doujin: 0, artbook: 0 },
      pendingCollectionCount: 0,
    }),
  ) {}

  getStats(): LibraryStats {
    const db = this.ctx.db;
    // 一遍扫完所有活着的图（窄覆盖索引 idx_images_live_stats，T22），类型张数也在这一遍里数
    const kindSums = CONTENT_KINDS.map((k) => `COALESCE(SUM(i.excluded_by IS NULL AND i.content_kind = '${k}'), 0) AS "k_${k}"`).join(',\n          ');
    const row = db
      .prepare(
        // 计数都在一遍扫描里做完（T22：原来每个数一个子查询，各扫一遍 8 万张图，合计 170 ms）
        `SELECT
          COALESCE(SUM(i.excluded_by IS NULL), 0) AS image_count,
          COALESCE(SUM(i.excluded_by IS NOT NULL), 0) AS excluded_count,
          COALESCE(SUM(i.excluded_by IS NULL AND ${QUEUE}), 0) AS unrecognized_count,
          COALESCE(SUM(CASE WHEN i.excluded_by IS NULL THEN i.bytes END), 0) AS total_bytes,
          (SELECT COUNT(*) FROM duplicate_groups g
             WHERE g.resolved_at IS NULL AND g.ignored = 0
               AND (SELECT COUNT(*) FROM duplicate_members m JOIN v_images vi ON vi.id = m.image_id
                     WHERE m.group_id = g.id) >= 2) AS duplicate_group_count,
          (SELECT MAX(last_scan_at) FROM library_roots WHERE removed_at IS NULL) AS last_scan_at,
          COALESCE(SUM(i.excluded_by IS NULL AND ${UNTAGGED_UNRECOGNIZED}), 0) AS untagged_count,
          MAX(CASE WHEN i.excluded_by IS NULL AND i.content_kind = 'illustration' THEN i.added_at END) AS last_added_at,
          COALESCE(SUM(i.excluded_by IS NULL AND i.tagged_at IS NULL AND NOT ${IN_COMIC_I}), 0) AS pending_tag_count,
          COALESCE(SUM(i.excluded_by IS NULL AND ${ART_KINDS_SQL} AND ${UNRECOGNIZED} AND i.collection_id IS NULL
             AND i.shelved_at IS NOT NULL), 0) AS shelved_count,
          COALESCE(SUM(i.excluded_by IS NULL AND i.original_at IS NOT NULL), 0) AS original_count,
          ${kindSums}
         FROM images i INDEXED BY idx_images_live_stats WHERE ${LIVE_IMAGES}`,
      )
      .get() as Record<`k_${ContentKind}`, number> & {
      image_count: number;
      excluded_count: number;
      unrecognized_count: number;
      total_bytes: number;
      duplicate_group_count: number;
      last_scan_at: string | null;
      untagged_count: number;
      last_added_at: string | null;
      pending_tag_count: number;
      shelved_count: number;
      original_count: number;
    };
    const kindCounts = Object.fromEntries(CONTENT_KINDS.map((k) => [k, 0])) as Record<ContentKind, number>;
    for (const k of CONTENT_KINDS) kindCounts[k] = row[`k_${k}`];

    // 近 7 天（本地时区，与 mock 相同：下标 6 = 今天）
    const now = this.ctx.clock();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = [0, 0, 0, 0, 0, 0, 0];
    const buckets = db
      .prepare(
        `SELECT CAST((@todayEndMs - 1 - unixepoch(added_at, 'subsec') * 1000) / 86400000 AS INTEGER) AS d, COUNT(*) AS n
         FROM v_illust_images WHERE added_at >= @since GROUP BY d`, // 首页「本周新收」只数插画（BI-11）
      )
      .all({ todayEndMs: today.getTime() + DAY, since: iso(today.getTime() - 6 * DAY) }) as { d: number; n: number }[];
    for (const { d, n } of buckets) if (d >= 0 && d <= 6) days[6 - d] = n;

    // 7 天内有文件夹首次导入 → 首页进入「刚导入」状态
    const since = iso(now - 7 * DAY);
    const imp = db
      .prepare(
        `SELECT MAX(imported_at) AS at,
                (SELECT COUNT(*) FROM v_counted_images i JOIN library_roots r2 ON r2.id = i.root_id
                  WHERE r2.imported_at >= @since) AS count
         FROM library_roots WHERE removed_at IS NULL AND imported_at >= @since`,
      )
      .get({ since }) as { at: string | null; count: number };

    const data = this.derived.get();
    const originalWork = db.prepare("SELECT id FROM works WHERE danbooru_tag = 'original'").pluck().get() as number | undefined;
    return {
      imageCount: row.image_count,
      characterCount: [...data.characters.values()].filter((c) => c.imageCount > 0).length,
      workCount: [...data.works.values()].filter((w) => w.imageCount > 0).length,
      unrecognizedCount: row.unrecognized_count,
      duplicateGroupCount: row.duplicate_group_count,
      excludedCount: row.excluded_count,
      customMatchableCount: this.customMatchableCount(),
      totalBytes: row.total_bytes,
      addedLast7Days: days,
      lastScanAt: row.last_scan_at,
      untaggedCount: row.untagged_count,
      shelvedCount: row.shelved_count,
      recentImport: imp.at ? { at: imp.at, count: imp.count } : null,
      lastAddedAt: row.last_added_at,
      kindCounts,
      pendingTagCount: row.pending_tag_count,
      ...this.collectionStats(),
      originalWorkId: originalWork === undefined ? null : toId(originalWork),
      originalCount: row.original_count,
    };
  }

  /** 别册首页（T27）：每一类的张数、30 天内张数、最多的顶层文件夹、最新 3 张预览；按 CONTENT_KINDS 顺序，7 项 */
  listContentKinds(): ContentKindSummary[] {
    const db = this.ctx.db;
    const cutoff = iso(this.ctx.clock() - RECENT_DAYS * DAY);
    const counts = new Map(
      (
        db
          .prepare(
            `SELECT content_kind AS k, COUNT(*) AS n, COALESCE(SUM(added_at >= ?), 0) AS r, MAX(added_at) AS last
             FROM v_counted_images GROUP BY content_kind`,
          )
          .all(cutoff) as { k: ContentKind; n: number; r: number; last: string | null }[]
      ).map((x) => [x.k, x]),
    );
    const tops = new Map<ContentKind, { top: string; n: number }>();
    for (const x of db
      .prepare(
        `SELECT content_kind AS k, substr(rel_path, 1, instr(rel_path, '/') - 1) AS top, COUNT(*) AS n
         FROM v_counted_images WHERE instr(rel_path, '/') > 0 GROUP BY 1, 2`,
      )
      .all() as { k: ContentKind; top: string; n: number }[]) {
      const cur = tops.get(x.k);
      if (!cur || x.n > cur.n) tops.set(x.k, x);
    }
    const previews = new Map<ContentKind, ContentKindSummary['previews']>();
    for (const x of db
      .prepare(
        `SELECT k, id, rating, color, width, height FROM (
           SELECT content_kind AS k, id, rating, dominant_color AS color, width, height,
                  ROW_NUMBER() OVER (PARTITION BY content_kind ORDER BY added_at DESC, id DESC) AS rn
           FROM v_counted_images) WHERE rn <= 3 ORDER BY k, rn`,
      )
      .all() as { k: ContentKind; id: number; rating: ContentKindSummary['previews'][number]['rating']; color: string | null; width: number; height: number }[]) {
      const list = previews.get(x.k) ?? [];
      list.push({ id: toId(x.id), rating: x.rating, dominantColor: x.color ?? DEFAULT_DOMINANT, width: x.width, height: x.height });
      previews.set(x.k, list);
    }
    return CONTENT_KINDS.map((kind) => {
      const c = counts.get(kind);
      return {
        kind,
        count: c?.n ?? 0,
        recentCount: c?.r ?? 0,
        lastAddedAt: c?.last ?? null,
        topFolder: tops.get(kind)?.top ?? null,
        previews: previews.get(kind) ?? [],
      };
    });
  }

  /** T11 建 custom_character_matches 表之前恒为 0 */
  private customMatchableCount(): number {
    const db = this.ctx.db;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_character_matches'").get();
    if (!exists) return 0;
    return db
      .prepare(
        `SELECT COUNT(*) FROM custom_character_matches m JOIN characters c ON c.id = m.character_id
         WHERE c.source = 'custom' AND c.danbooru_tag IS NULL AND m.dismissed = 0`,
      )
      .pluck()
      .get() as number;
  }

  listWorks(query: ListWorksQuery): Work[] {
    const list = byId(this.derived.get().works.values()).filter((w) => w.imageCount > 0);
    const sort = query.sort ?? 'imageCount';
    list.sort((a, b) =>
      sort === 'name'
        ? zhCollator.compare(a.name, b.name)
        : sort === 'recent'
          ? b.recentImageCount - a.recentImageCount
          : b.imageCount - a.imageCount,
    );
    return list.map(toWork);
  }

  getWork(id: string): Work | null {
    const n = parseId(id);
    const w = n === null ? undefined : this.derived.get().works.get(n);
    return w ? toWork(w) : null;
  }

  private filterCharacters(query: { workId?: string; q?: string; source?: CharacterSource }): CharacterRec[] {
    const cutoff = iso(this.ctx.clock() - RECENT_DAYS * DAY);
    const workId = query.workId && query.workId !== 'recent' ? parseId(query.workId) : null;
    if (query.workId && query.workId !== 'recent' && workId === null) return [];
    const k = query.q ? searchKey(query.q) : '';
    return byId(this.derived.get().characters.values()).filter((c) => {
      if (query.source && c.source !== query.source) return false;
      if (query.workId === 'recent') {
        if (c.lastAddedAt === null || c.lastAddedAt < cutoff) return false;
      } else if (workId !== null && !c.workIds.includes(workId)) {
        return false;
      }
      if (k && !c.keys.some((x) => x.includes(k))) return false;
      return true;
    });
  }

  listCharacters(query: ListCharactersQuery): ListCharactersResponse {
    // 「插画 0 张、但有其他类型」的角色默认隐藏（BI-2：0 张图的新建角色照常显示）
    // 识别器自动建的角色一张图都不剩了（最后一张被取消、排除或删掉）也不再显示；手动新建、改过名、置顶的照常显示。
    // 只是不列出来，角色还在，之后又有图归进来就会回来
    const matched = this.filterCharacters(query).filter((c) => !emptyAuto(c));
    const otherOnly = (c: CharacterRec) => c.imageCount === 0 && c.otherCount > 0;
    const all = query.includeOther ? matched : matched.filter((c) => !otherOnly(c));
    const sort = query.sort ?? 'imageCount';
    all.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case 'name':
          return zhCollator.compare(a.name, b.name);
        case 'recent':
          return (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? '');
        case 'newCount':
          return b.newCount - a.newCount || b.imageCount - a.imageCount;
        default:
          return b.imageCount - a.imageCount;
      }
    });
    const page = paginateOffset(all, query.cursor, query.limit);
    return { ...page, items: page.items.map(toCharacter), otherOnlyCount: query.includeOther ? 0 : matched.length - all.length };
  }

  topCharacters(query: TopCharactersQuery): Character[] {
    // 「最近在收」按 30 天内的新图数排（CR-5），其余按总张数
    const recent = query.workId === 'recent';
    return this.filterCharacters({ workId: query.workId })
      .filter((c) => c.imageCount > 0)
      .sort((a, b) => (recent ? b.recentCount - a.recentCount : 0) || b.imageCount - a.imageCount)
      .slice(0, query.limit ?? 9)
      .map(toCharacter);
  }

  getCharacter(id: string): GetCharacterResponse | null {
    const n = parseId(id);
    const data = this.derived.get();
    const c = n === null ? undefined : data.characters.get(n);
    if (!c) return null;
    const related = this.ctx
      .stmt(
        `SELECT o.character_id AS id, COUNT(*) AS shared
         FROM image_characters me
         JOIN v_counted_images i ON i.id = me.image_id
         JOIN image_characters o ON o.image_id = me.image_id AND o.character_id <> me.character_id
         WHERE me.character_id = ? AND i.content_kind IN ('illustration','comic')
         GROUP BY o.character_id
         ORDER BY shared DESC, o.character_id ASC
         LIMIT 8`,
      )
      .all(c.id) as { id: number; shared: number }[];
    return {
      character: toCharacter(c),
      works: c.workIds.flatMap((wid) => {
        const w = data.works.get(wid);
        return w ? [toWork(w)] : [];
      }),
      related: related.flatMap((r) => {
        const o = data.characters.get(r.id);
        return o ? [{ character: toCharacter(o), sharedCount: r.shared }] : [];
      }),
    };
  }

  /**
   * 「换封面」候选（CB-7）：和派生缓存 C 同一套查询与排序，只是限定这个角色、不设前 40 的上限。
   * 封面不是手动设的时，把当前自动封面（可能因为和别的角色去重换成了次优图）挪到第一张，和详情页看到的一致。
   */
  listCoverCandidates(id: string, limit: number): CoverCandidatesResponse | null {
    const n = parseId(id);
    const c = n === null ? undefined : this.derived.get().characters.get(n);
    if (!c) return null;
    const rows = this.ctx
      .stmt(
        `WITH crowd AS (SELECT image_id, COUNT(*) AS n FROM image_characters GROUP BY image_id)
         SELECT ${COVER_CANDIDATE_COLS}
         FROM image_characters ic
         JOIN v_counted_images i ON i.id = ic.image_id
         LEFT JOIN crowd cr ON cr.image_id = i.id
         WHERE ic.character_id = ? AND i.content_kind IN ('illustration','comic')`,
      )
      .all(c.id) as CoverCandidate[];
    const scored = scoreCoverCandidates(rows, loadCoverTags(this.ctx.db, rows.map((r) => r.iid)));
    // 手动封面不可见时 effectiveCoverId 也是自动封面
    const usingAuto = !c.coverManual || c.effectiveCoverId !== c.coverImageId;
    if (usingAuto && c.effectiveCoverId !== null) {
      const at = scored.findIndex((x) => x.iid === c.effectiveCoverId);
      if (at > 0) scored.unshift(...scored.splice(at, 1));
    }
    const top = scored.slice(0, limit);
    const score = new Map(top.map((x) => [x.iid, Math.round(x.q * 10) / 10]));
    return {
      items: loadImageItems(
        this.ctx.db,
        top.map((x) => x.iid),
      ).map((item) => ({ ...item, coverScore: score.get(Number(item.id)) ?? 0 })),
    };
  }
}
