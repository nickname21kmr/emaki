import {
  CONTENT_KINDS,
  UNRECOGNIZED_ANNEX_KINDS,
  UNRECOGNIZED_THEMES,
  type UnrecognizedAnnexKind,
  type UnrecognizedSummary,
  type UnrecognizedTheme,
  matchesQuery,
  type ContentKind,
  type ContentKindSummary,
  type CoverCandidatesResponse,
  searchKey,
  type AddLibraryRootBody,
  type BulkCollectionsBody,
  type Artist,
  type BulkImagesBody,
  type MoveImagesBody,
  type CollectionSummary,
  type CreateCollectionBody,
  type GetCollectionResponse,
  type ListCollectionsQuery,
  type UpdateCollectionBody,
  type Character,
  type CharacterSuggestion,
  type CreateCharacterBody,
  type CreateExclusionBody,
  type DuplicateGroup,
  type Exclusion,
  type GetCharacterResponse,
  type ID,
  type ImageDetail,
  type ImageItem,
  type ImageStatus,
  type Job,
  type JobKind,
  type LibraryStats,
  type ListCharactersQuery,
  type ListCharactersResponse,
  type ListDuplicatesQuery,
  type ListImagesQuery,
  type ListUnrecognizedQuery,
  type ListUnrecognizedResponse,
  type ListWorksQuery,
  type MutationResult,
  type RetagResult,
  type Page,
  type Rating,
  type SearchHit,
  type SearchQuery,
  type TagSuggestion,
  type TagSuggestionsQuery,
  TAG_FILTER_MIN_SCORE,
  type Settings,
  type ThumbWidth,
  type TopCharactersQuery,
  type UnrecognizedItem,
  type UpdateCharacterBody,
  type UpdateImageBody,
  type UpdateSettingsBody,
  type Work,
} from '@emaki/shared';
import type { EventBus } from '../../core/events.ts';
import { JobQueue, type JobRunner } from '../../core/jobs.ts';
import { done, UndoStack } from '../../core/undo.ts';
import { BadRequestError, ConflictError, NeedsConfirmError, NotFoundError } from '../../http/errors.ts';
import type { DataSource, FileResponse } from '../DataSource.ts';
import { buildMockDb, type CharacterRow, type ImageRow, type MockDb, type WorkRow } from './fixtures.ts';
import { MockCollections } from './collections.ts';
import { hashString, placeholderSvg } from './placeholder.ts';
import { mockDominantColor, workColorFromHue } from '../../util/color.ts';
import { classifyContent } from '../../services/classify/rules.ts';
import { artScore, classifyTheme, matchesBrowseTheme, resolveTheme } from '../../services/classify/theme.ts';
import { describeKindReason } from '../sqlite/hydrate.ts';
import { coverQuality, isUnfitCover } from '../../services/covers/quality.ts';
import { assertKindValue, KIND_LABEL } from '../sqlite/kinds.ts';
import { artistAutoMessage, artistEditMessage, normArtists } from '../artistEdits.ts';
import { normalizeSubdir } from '../sqlite/move.ts';

const kindOf = (img: ImageRow): ContentKind => img.kind ?? 'illustration';
const isArt = (img: ImageRow) => kindOf(img) === 'illustration' || kindOf(img) === 'comic';
/** 画师标签的显示名（和 sqlite 没有 Danbooru 资料时一样） */
const prettyTag = (tag: string) => tag.replace(/_/g, ' ');

const DAY = 86_400_000;
const RECENT_DAYS = 30;

const RATING_LABEL: Record<Rating, string> = {
  general: '全年龄',
  sensitive: '轻微',
  questionable: '较敏感',
  explicit: '限制级',
};

/** 各种派生数据，数据变更后懒重建。 */
interface Index {
  visible: ImageRow[];
  charImageCount: Map<ID, number>;
  charLastAdded: Map<ID, string>;
  charRecentCount: Map<ID, number>;
  charOtherCount: Map<ID, number>;
  workImageCount: Map<ID, number>;
  workOtherCount: Map<ID, number>;
  workRecentCount: Map<ID, number>;
  workCharCount: Map<ID, number>;
  exclusionCount: Map<ID, number>;
  exclusionPreview: Map<ID, ID[]>;
  tagCount: Map<string, number>;
  charByTag: Map<string, CharacterRow>;
  /** 每个角色的候选封面（懒算，见 coverCands） */
  coverCands?: Map<ID, MockCoverCand[]>;
}

interface MockCoverCand {
  img: ImageRow;
  tier: number;
  q: number;
  /** 在 db.images 里的顺序：同分时后加的在前（对应 sqlite 的 id 倒序） */
  ord: number;
}

const RATING_TIER: Record<Rating, number> = { general: 0, sensitive: 0, questionable: 1, explicit: 2 };

/**
 * 内存假数据实现。行为尽量贴近真实实现（含撤销、后台任务进度、SSE 事件），
 * 这样前端在 mock 模式下开发完，切到 sqlite 就能直接用。
 */
export class MockDataSource implements DataSource {
  private readonly db: MockDb;
  private readonly undoStack = new UndoStack();
  private readonly jobs: JobQueue;
  private index: Index | null = null;
  private readonly now: number;

  /** 测试（契约测试）会注入固定的数据和时间 */
  constructor(
    private readonly bus: EventBus,
    opts: { db?: MockDb; now?: number } = {},
  ) {
    this.now = opts.now ?? Date.now();
    this.db = opts.db ?? buildMockDb(this.now);
    this.jobs = new JobQueue(bus, (kind) => this.mockRunner(kind));
    this.collections = new MockCollections({
      db: this.db,
      now: this.now,
      visible: () => this.idx.visible,
      imageWorkIds: (img) => this.imageWorkIds(img),
      toCharacter: (row) => this.toCharacter(row),
      toWork: (row) => this.toWork(row),
      withUndo: (message, revert) => this.withUndo(message, revert),
    });
  }

  private readonly collections: MockCollections;

  // ------------------------------------------------------------ 内部工具

  /** 任何修改之后调用：让派生数据失效，并通知前端刷新。 */
  private touch(): void {
    this.index = null;
    this.bus.emit({ type: 'library-changed', reason: 'mutation' });
  }

  private isVisible(img: ImageRow): boolean {
    if (img.trashed) return false;
    const root = this.db.settings.libraryRoots.find((r) => r.id === img.libraryRootId);
    return !!root && root.enabled;
  }

  private status(img: ImageRow): ImageStatus {
    if (img.excludedBy) return 'excluded';
    // 有角色，或不是插画 / 漫画 → recognized；放下的仍是 unrecognized（与 sqlite 的 hydrate 同口径）
    return img.characterIds.length || img.originalAt || !isArt(img) ? 'recognized' : 'unrecognized';
  }

  /** 「原创」作品（标签 original）；没有就现建（sqlite 同样） */
  private originalWorkId(): ID {
    for (const w of this.db.works.values()) if (w.danbooruTag === 'original') return w.id;
    const w = { id: 'w-original', name: '原创', danbooruTag: 'original', aliases: ['原创', 'original'], hue: 30 };
    this.db.works.set(w.id, w);
    return w.id;
  }

  /** 逐张未识别队列（sql.ts 的 QUEUE）：计入张数、插画或漫画、没放下、没角色 */
  private inQueue(img: ImageRow): boolean {
    return !img.excludedBy && isArt(img) && !img.shelvedAt && !img.originalAt && !img.characterIds.length && !img.collectionId;
  }

  /** 图库文字搜索用：这张图的角色（名字、标签、别名）和作品（名字、标签、别名），同 sqlite 的 matchText */
  private nameKeysOf(img: ImageRow): (string | null)[] {
    const chars = img.characterIds.flatMap((cid) => {
      const c = this.db.characters.get(cid);
      return c ? [c.name, c.danbooruTag, ...c.aliases] : [];
    });
    const works = this.imageWorkIds(img).flatMap((wid) => {
      const w = this.db.works.get(wid);
      return w ? [w.name, w.danbooruTag, ...w.aliases] : [];
    });
    return [...chars, ...works];
  }

  private imageWorkIds(img: ImageRow): ID[] {
    const ids = new Set<ID>(img.copyrightWorkIds);
    for (const cid of img.characterIds) for (const wid of this.db.characters.get(cid)?.workIds ?? []) ids.add(wid);
    return [...ids];
  }

  private get idx(): Index {
    if (this.index) return this.index;
    const visible = [...this.db.images.values()].filter((img) => this.isVisible(img));
    const charImageCount = new Map<ID, number>();
    const charLastAdded = new Map<ID, string>();
    const charRecentCount = new Map<ID, number>();
    const charOtherCount = new Map<ID, number>();
    const workImageCount = new Map<ID, number>();
    const workOtherCount = new Map<ID, number>();
    const workRecentCount = new Map<ID, number>();
    const exclusionCount = new Map<ID, number>();
    const exclusionPreview = new Map<ID, ID[]>();
    const tagCount = new Map<string, number>();
    const recentCutoff = this.now - RECENT_DAYS * DAY;

    for (const img of visible) {
      if (img.excludedBy) {
        exclusionCount.set(img.excludedBy, (exclusionCount.get(img.excludedBy) ?? 0) + 1);
        const prev = exclusionPreview.get(img.excludedBy) ?? [];
        if (prev.length < 4) exclusionPreview.set(img.excludedBy, [...prev, img.id]);
        continue;
      }
      for (const t of img.tags) if (t.category === 'general') tagCount.set(t.tag, (tagCount.get(t.tag) ?? 0) + 1);
      // 张数、+N、最近在收只数插画（D3）；其余类型记在 otherCount
      if (kindOf(img) !== 'illustration') {
        for (const cid of img.characterIds) charOtherCount.set(cid, (charOtherCount.get(cid) ?? 0) + 1);
        for (const wid of this.imageWorkIds(img)) workOtherCount.set(wid, (workOtherCount.get(wid) ?? 0) + 1);
        continue;
      }
      const recent = Date.parse(img.addedAt) >= recentCutoff;
      for (const cid of img.characterIds) {
        charImageCount.set(cid, (charImageCount.get(cid) ?? 0) + 1);
        if (recent) charRecentCount.set(cid, (charRecentCount.get(cid) ?? 0) + 1);
        const last = charLastAdded.get(cid);
        if (!last || img.addedAt > last) charLastAdded.set(cid, img.addedAt);
      }
      for (const wid of this.imageWorkIds(img)) {
        workImageCount.set(wid, (workImageCount.get(wid) ?? 0) + 1);
        if (recent) workRecentCount.set(wid, (workRecentCount.get(wid) ?? 0) + 1);
      }
    }

    const workCharCount = new Map<ID, number>();
    const charByTag = new Map<string, CharacterRow>();
    for (const ch of this.db.characters.values()) {
      // 只数有插画的角色（和角色列表的默认口径一致）
      if ((charImageCount.get(ch.id) ?? 0) > 0) for (const wid of ch.workIds) workCharCount.set(wid, (workCharCount.get(wid) ?? 0) + 1);
      if (ch.danbooruTag) charByTag.set(ch.danbooruTag, ch);
    }

    this.index = {
      visible,
      charImageCount,
      charLastAdded,
      charRecentCount,
      charOtherCount,
      workImageCount,
      workOtherCount,
      workRecentCount,
      workCharCount,
      exclusionCount,
      exclusionPreview,
      tagCount,
      charByTag,
    };
    return this.index;
  }

  private toWork(row: WorkRow): Work {
    const idx = this.idx;
    // 作品封面：主作品是它的角色优先 → 分级安全 → 张数多，取最多 3 张互不相同的角色封面（和 sqlite 同一套排序，
    // 只是 mock 不做跨作品去重）；[0] 就是 coverImageId
    const tier = (id: ID) => ({ general: 0, sensitive: 0, questionable: 1, explicit: 2 })[this.coverRating(id)];
    const chars = [...this.db.characters.values()]
      .filter((c) => c.workIds.includes(row.id) && c.coverImageId)
      .sort(
        (a, b) =>
          Number(b.workIds[0] === row.id) - Number(a.workIds[0] === row.id) ||
          tier(a.coverImageId!) - tier(b.coverImageId!) ||
          (idx.charImageCount.get(b.id) ?? 0) - (idx.charImageCount.get(a.id) ?? 0),
      );
    const covers: Work['covers'] = [];
    for (const c of chars) {
      if (covers.length >= 3 || covers.some((x) => x.imageId === c.coverImageId)) continue;
      covers.push({ imageId: c.coverImageId!, rating: this.coverRating(c.coverImageId), color: this.coverColor(c.coverImageId), focus: c.coverFocus });
    }
    const first = covers[0] ?? null;
    return {
      id: row.id,
      name: row.name,
      danbooruTag: row.danbooruTag,
      aliases: row.aliases,
      characterCount: idx.workCharCount.get(row.id) ?? 0,
      imageCount: idx.workImageCount.get(row.id) ?? 0,
      otherCount: idx.workOtherCount.get(row.id) ?? 0,
      recentImageCount: idx.workRecentCount.get(row.id) ?? 0,
      coverImageId: first?.imageId ?? null,
      coverRating: first?.rating ?? 'general',
      color: workColorFromHue(row.hue),
      covers,
      coverColor: first?.color ?? null,
    };
  }

  /**
   * 每个角色的候选封面：和 sqlite 的自动封面同一套规则（services/covers/quality.ts）——
   * 只看计入张数的插画和漫画，去掉截图类，漫画页最后 → 分级档位 → 画面质量分。mock 不做角色间去重。
   */
  private get coverCands(): Map<ID, MockCoverCand[]> {
    const idx = this.idx;
    if (idx.coverCands) return idx.coverCands;
    const order = new Map([...this.db.images.keys()].map((id, i) => [id, i]));
    const map = new Map<ID, MockCoverCand[]>();
    for (const img of idx.visible) {
      if (img.excludedBy || !isArt(img) || !img.characterIds.length) continue;
      const tags = img.tags.filter((t) => t.category === 'general').map((t): [string, number] => [t.tag, t.score]);
      if (isUnfitCover(img.fileName, tags)) continue;
      const tier = RATING_TIER[img.rating] + (kindOf(img) === 'comic' ? 3 : 0);
      for (const cid of img.characterIds) {
        const tag = this.db.characters.get(cid)?.danbooruTag;
        const cs = img.tags.find((t) => t.category === 'character' && t.tag === tag)?.score ?? 0.9;
        const q = coverQuality(
          { w: img.width, h: img.height, fileName: img.fileName, fav: img.favorite ? 1 : 0, cs, others: img.characterIds.length - 1 },
          tags,
        );
        const cand = { img, tier, q, ord: order.get(img.id) ?? 0 };
        const list = map.get(cid);
        if (list) list.push(cand);
        else map.set(cid, [cand]);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.tier - b.tier || b.q - a.q || b.ord - a.ord);
    idx.coverCands = map;
    return map;
  }

  /** 实际显示的封面：手动设的优先，否则取候选第一张 */
  private effectiveCover(row: CharacterRow): ID | null {
    return row.coverImageId ?? this.coverCands.get(row.id)?.[0]?.img.id ?? null;
  }

  async listCoverCandidates(id: ID, limit: number): Promise<CoverCandidatesResponse> {
    const row = this.requireCharacter(id);
    const list = [...(this.coverCands.get(id) ?? [])];
    const manual = row.coverManual ?? row.coverImageId !== null;
    const current = this.effectiveCover(row);
    if (!manual && current) {
      const at = list.findIndex((c) => c.img.id === current);
      if (at > 0) list.unshift(...list.splice(at, 1));
    }
    return {
      items: list.slice(0, limit).map((c) => ({ ...this.toImage(c.img), coverScore: Math.round(c.q * 10) / 10 })),
    };
  }

  private toCharacter(row: CharacterRow): Character {
    const idx = this.idx;
    const coverId = this.effectiveCover(row);
    return {
      id: row.id,
      name: row.name,
      danbooruTag: row.danbooruTag,
      source: row.source,
      aliases: row.aliases,
      workIds: row.workIds,
      imageCount: idx.charImageCount.get(row.id) ?? 0,
      otherCount: idx.charOtherCount.get(row.id) ?? 0,
      newCount: row.newCount,
      coverImageId: coverId,
      coverRating: this.coverRating(coverId),
      coverFocus: row.coverFocus,
      coverManual: row.coverManual ?? row.coverImageId !== null,
      coverColor: this.coverColor(coverId),
      recentCount: idx.charRecentCount.get(row.id) ?? 0,
      lastAddedAt: idx.charLastAdded.get(row.id) ?? null,
      pinned: row.pinned,
    };
  }

  private coverColor(imageId: ID | null): string | null {
    const img = imageId ? this.db.images.get(imageId) : undefined;
    return img ? mockDominantColor(img.hue, img.id) : null;
  }

  private coverRating(imageId: ID | null): Rating {
    return (imageId && this.db.images.get(imageId)?.rating) || 'general';
  }

  private toImage(row: ImageRow): ImageItem {
    return {
      id: row.id,
      relPath: row.relPath,
      fileName: row.fileName,
      libraryRootId: row.libraryRootId,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      format: row.format,
      addedAt: row.addedAt,
      modifiedAt: row.modifiedAt,
      rating: row.rating,
      status: this.status(row),
      kind: kindOf(row),
      characterIds: row.characterIds,
      characterNames: row.characterIds.map((id) => this.db.characters.get(id)?.name ?? ''),
      workIds: this.imageWorkIds(row),
      dominantColor: mockDominantColor(row.hue, row.id),
      source: row.source,
      favorite: row.favorite,
      original: !!row.originalAt,
    };
  }

  private suggestionsFor(row: ImageRow): CharacterSuggestion[] {
    return row.suggestions.map(([tag, score]) => {
      const ch = this.idx.charByTag.get(tag) ?? null;
      const work = ch ? this.db.works.get(ch.workIds[0]!) : undefined;
      return {
        characterId: ch?.id ?? null,
        danbooruTag: tag,
        name: ch?.name ?? humanizeTag(tag),
        workName: work?.name ?? null,
        score,
      };
    });
  }

  private requireImage(id: ID): ImageRow {
    const img = this.db.images.get(id);
    if (!img || !this.isVisible(img)) throw new NotFoundError('图片');
    return img;
  }

  private requireCharacter(id: ID): CharacterRow {
    const ch = this.db.characters.get(id);
    if (!ch) throw new NotFoundError('角色');
    return ch;
  }

  private withUndo(message: string, revert: () => void): MutationResult {
    this.touch();
    return this.undoStack.result(message, () => {
      revert();
      this.touch();
    });
  }

  // ------------------------------------------------------------ 统计

  async getStats(): Promise<LibraryStats> {
    const idx = this.idx;
    let unrecognized = 0;
    let shelved = 0;
    let excluded = 0;
    let untagged = 0;
    let pendingTag = 0;
    let lastAdded: string | null = null;
    const kindCounts = Object.fromEntries(CONTENT_KINDS.map((k) => [k, 0])) as Record<ContentKind, number>;
    let bytes = 0;
    const days = [0, 0, 0, 0, 0, 0, 0];
    const today = new Date(this.now);
    today.setHours(0, 0, 0, 0);
    for (const img of idx.visible) {
      const s = this.status(img);
      if (s === 'excluded') {
        excluded++;
        continue; // 体积和 7 天新增只算「计入张数」的图
      }
      if (!img.excludedBy && isArt(img) && img.shelvedAt && !img.originalAt && !img.characterIds.length && !img.collectionId) shelved++;
      if (this.inQueue(img)) {
        unrecognized++;
        if (!img.tagged && kindOf(img) !== 'comic') untagged++;
      }
      kindCounts[kindOf(img)]++;
      if (!img.tagged) pendingTag++;
      bytes += img.bytes;
      if (kindOf(img) !== 'illustration') continue; // 最晚入库、本周新收只数插画（BI-11）
      if (!lastAdded || img.addedAt > lastAdded) lastAdded = img.addedAt;
      const dayIndex = 6 - Math.floor((today.getTime() + DAY - Date.parse(img.addedAt)) / DAY);
      if (dayIndex >= 0 && dayIndex < 7) days[dayIndex]! += 1;
    }
    const lastScanAt = this.db.settings.libraryRoots.reduce<string | null>(
      (max, r) => (r.lastScanAt && (!max || r.lastScanAt > max) ? r.lastScanAt : max),
      null,
    );
    // 与 listDuplicates 一致：未解决、且可见成员 ≥ 2 的组
    const duplicateGroupCount = this.db.duplicates.filter(
      (d) => !d.resolved && d.imageIds.filter((id) => this.db.images.get(id) && this.isVisible(this.db.images.get(id)!)).length > 1,
    ).length;
    const customMatchable = [...this.db.characters.values()].filter((c) => c.source === 'custom' && !c.danbooruTag);
    return {
      imageCount: idx.visible.length - excluded,
      characterCount: [...this.db.characters.values()].filter((c) => (idx.charImageCount.get(c.id) ?? 0) > 0).length,
      workCount: [...this.db.works.values()].filter((w) => (idx.workImageCount.get(w.id) ?? 0) > 0).length,
      unrecognizedCount: unrecognized,
      duplicateGroupCount,
      excludedCount: excluded,
      // mock：假设第一个未绑定的自建角色在 Danbooru 上有同名标签
      customMatchableCount: Math.min(1, customMatchable.length),
      totalBytes: bytes,
      addedLast7Days: days,
      lastScanAt,
      untaggedCount: untagged,
      shelvedCount: shelved,
      recentImport: this.recentImport(),
      lastAddedAt: lastAdded,
      kindCounts,
      pendingTagCount: pendingTag,
      ...this.collections.stats(),
      originalWorkId: [...this.db.works.values()].find((w) => w.danbooruTag === 'original')?.id ?? null,
      originalCount: idx.visible.filter((img) => !img.excludedBy && img.originalAt).length,
    };
  }

  async listContentKinds(): Promise<ContentKindSummary[]> {
    const cutoff = new Date(this.now - RECENT_DAYS * DAY).toISOString();
    const counted = this.idx.visible.filter((img) => !img.excludedBy);
    return CONTENT_KINDS.map((kind) => {
      const rows = counted
        .filter((img) => kindOf(img) === kind)
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id.localeCompare(a.id));
      const tops = new Map<string, number>();
      for (const img of rows) {
        const k = img.relPath.includes('/') ? img.relPath.slice(0, img.relPath.indexOf('/')) : null;
        if (k) tops.set(k, (tops.get(k) ?? 0) + 1);
      }
      const top = [...tops].sort((a, b) => b[1] - a[1])[0];
      return {
        kind,
        count: rows.length,
        recentCount: rows.filter((img) => img.addedAt >= cutoff).length,
        lastAddedAt: rows[0]?.addedAt ?? null,
        topFolder: top?.[0] ?? null,
        previews: rows.slice(0, 3).map((img) => ({
          id: img.id,
          rating: img.rating,
          dominantColor: mockDominantColor(img.hue, img.id),
          width: img.width,
          height: img.height,
        })),
      };
    });
  }

  /** 7 天内有文件夹首次导入：at = 最晚的导入时间，count = 这些文件夹里计入张数的图 */
  private recentImport(): { at: string; count: number } | null {
    const since = new Date(this.now - 7 * DAY).toISOString();
    const roots = this.db.settings.libraryRoots.filter((r) => r.importedAt && r.importedAt >= since);
    if (!roots.length) return null;
    const ids = new Set(roots.map((r) => r.id));
    return {
      at: roots.reduce((m, r) => (r.importedAt! > m ? r.importedAt! : m), roots[0]!.importedAt!),
      count: this.idx.visible.filter((img) => ids.has(img.libraryRootId) && this.status(img) !== 'excluded').length,
    };
  }

  // ------------------------------------------------------------ 合集（T38c）

  /** 画师：mock 没有 Danbooru 资料，每个标签自成一位，名字 = 标签 */
  async listArtists(): Promise<Artist[]> {
    const by = new Map<string, { n: number; best: ImageRow; score: number }>();
    // 封面：全年龄优先，再按分数
    const better = (img: ImageRow, score: number, e: { best: ImageRow; score: number }) =>
      (img.rating === 'general') !== (e.best.rating === 'general') ? img.rating === 'general' : score > e.score;
    for (const img of this.idx.visible) {
      if (this.status(img) === 'excluded' || kindOf(img) !== 'illustration') continue;
      for (const a of img.artists ?? []) {
        const e = by.get(a.tag);
        if (!e) by.set(a.tag, { n: 1, best: img, score: a.score });
        else {
          e.n++;
          if (better(img, a.score, e)) Object.assign(e, { best: img, score: a.score });
        }
      }
    }
    return [...by]
      .map(([tag, e]): Artist => ({
        tag,
        name: prettyTag(tag),
        tags: [tag],
        aliases: [],
        twitter: null,
        imageCount: e.n,
        cover: { id: e.best.id, dominantColor: mockDominantColor(e.best.hue, e.best.id), rating: e.best.rating, width: e.best.width, height: e.best.height },
      }))
      .sort((a, b) => b.imageCount - a.imageCount || a.tag.localeCompare(b.tag));
  }

  async listCollections(query: ListCollectionsQuery): Promise<CollectionSummary[]> {
    return this.collections.list(query);
  }
  async getCollection(id: ID): Promise<GetCollectionResponse | null> {
    return this.collections.get(id);
  }
  async createCollection(body: CreateCollectionBody): Promise<MutationResult & { collection: CollectionSummary }> {
    return this.collections.create(body);
  }
  async updateCollection(id: ID, body: UpdateCollectionBody): Promise<MutationResult> {
    return this.collections.update(id, body);
  }
  async deleteCollection(id: ID): Promise<MutationResult> {
    return this.collections.dismiss(id);
  }
  async bulkCollections(body: BulkCollectionsBody): Promise<MutationResult> {
    return this.collections.bulk(body);
  }

  // ------------------------------------------------------------ 作品

  async listWorks(query: ListWorksQuery): Promise<Work[]> {
    const works = [...this.db.works.values()].map((w) => this.toWork(w)).filter((w) => w.imageCount > 0);
    const sort = query.sort ?? 'imageCount';
    works.sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'zh')
        : sort === 'recent'
          ? b.recentImageCount - a.recentImageCount
          : b.imageCount - a.imageCount,
    );
    return works;
  }

  async getWork(id: ID): Promise<Work | null> {
    const row = this.db.works.get(id);
    return row ? this.toWork(row) : null;
  }

  // ------------------------------------------------------------ 角色

  private filterCharacters(query: { workId?: string; q?: string; source?: string }): Character[] {
    const recentCutoff = new Date(this.now - RECENT_DAYS * DAY).toISOString();
    return [...this.db.characters.values()]
      .filter((row) => {
        if (query.source && row.source !== query.source) return false;
        if (query.workId === 'recent') {
          const last = this.idx.charLastAdded.get(row.id);
          if (!last || last < recentCutoff) return false;
        } else if (query.workId && !row.workIds.includes(query.workId)) {
          return false;
        }
        if (query.q) {
          const workNames = row.workIds.flatMap((wid) => {
            const w = this.db.works.get(wid);
            return w ? [w.name, ...w.aliases] : [];
          });
          if (!matchesQuery(query.q, [row.name, row.danbooruTag, ...row.aliases, ...workNames])) return false;
        }
        return true;
      })
      .map((row) => this.toCharacter(row));
  }

  async listCharacters(query: ListCharactersQuery): Promise<ListCharactersResponse> {
    // 「插画 0 张、但有其他类型」的角色默认隐藏（BI-2）；识别器自动建、一张图都不剩的也不显示（同 sqlite）
    const matched = this.filterCharacters(query).filter((c) => {
      const row = this.db.characters.get(c.id);
      return !(c.imageCount === 0 && c.otherCount === 0 && row?.source === 'danbooru' && !row.nameLocked && !row.pinned);
    });
    const all = query.includeOther ? matched : matched.filter((c) => !(c.imageCount === 0 && c.otherCount > 0));
    const sort = query.sort ?? 'imageCount';
    all.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case 'name':
          return a.name.localeCompare(b.name, 'zh');
        case 'recent':
          return (b.lastAddedAt ?? '').localeCompare(a.lastAddedAt ?? '');
        case 'newCount':
          return b.newCount - a.newCount || b.imageCount - a.imageCount;
        default:
          return b.imageCount - a.imageCount;
      }
    });
    return { ...paginate(all, query.cursor, query.limit), otherOnlyCount: matched.length - all.length };
  }

  async topCharacters(query: TopCharactersQuery): Promise<Character[]> {
    // 「最近在收」按 30 天内的新图数排（CR-5），其余按总张数
    const recent = query.workId === 'recent';
    return this.filterCharacters(query)
      .filter((c) => c.imageCount > 0)
      .sort((a, b) => (recent ? b.recentCount - a.recentCount : 0) || b.imageCount - a.imageCount)
      .slice(0, query.limit ?? 9);
  }

  async getCharacter(id: ID): Promise<GetCharacterResponse | null> {
    const row = this.db.characters.get(id);
    if (!row) return null;
    const shared = new Map<ID, number>();
    for (const img of this.idx.visible) {
      if (img.excludedBy || !isArt(img) || !img.characterIds.includes(id)) continue; // 同框只看插画和漫画（BI-12）
      for (const other of img.characterIds) if (other !== id) shared.set(other, (shared.get(other) ?? 0) + 1);
    }
    const related = [...shared.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([cid, sharedCount]) => ({ character: this.toCharacter(this.db.characters.get(cid)!), sharedCount }));
    return {
      character: this.toCharacter(row),
      works: row.workIds.flatMap((wid) => {
        const w = this.db.works.get(wid);
        return w ? [this.toWork(w)] : [];
      }),
      related,
    };
  }

  /** 标签被别的角色占用 → 409（与 sqlite 一致） */
  private assertTagFree(tag: string, exceptId?: ID): void {
    const owner = [...this.db.characters.values()].find((c) => c.danbooruTag === tag && c.id !== exceptId);
    if (owner) throw new ConflictError(`标签 ${tag} 已属于「${owner.name}」，可以用「合并」把两个角色合在一起`);
  }

  async createCharacter(body: CreateCharacterBody): Promise<MutationResult & { character: Character }> {
    if (!body.name.trim()) throw new BadRequestError('角色名不能为空');
    for (const wid of body.workIds) if (!this.db.works.has(wid)) throw new NotFoundError(`作品 ${wid}`);
    if (body.danbooruTag) this.assertTagFree(body.danbooruTag);
    const row: CharacterRow = {
      id: `c${this.db.characters.size + 1}_${hashString(body.name).toString(36)}`,
      name: body.name.trim(),
      danbooruTag: body.danbooruTag ?? null,
      source: body.danbooruTag ? 'danbooru' : 'custom',
      aliases: body.aliases ?? [],
      workIds: body.workIds,
      newCount: 0,
      coverImageId: null,
      coverFocus: null,
      pinned: false,
      nameLocked: true,
    };
    this.db.characters.set(row.id, row);
    const result = this.withUndo(`已新建角色「${row.name}」`, () => {
      this.db.characters.delete(row.id);
    });
    return { ...result, character: this.toCharacter(row) };
  }

  async updateCharacter(id: ID, body: UpdateCharacterBody): Promise<MutationResult> {
    const row = this.requireCharacter(id);
    const before = structuredClone(row);
    if (body.name !== undefined) {
      row.name = body.name.trim() || row.name;
      row.nameLocked = true;
    }
    if (body.aliases !== undefined) row.aliases = body.aliases;
    if (body.danbooruTag) this.assertTagFree(body.danbooruTag, row.id);
    if (body.danbooruTag !== undefined) {
      row.danbooruTag = body.danbooruTag;
      if (body.danbooruTag) row.source = 'danbooru';
    }
    if (body.workIds !== undefined) row.workIds = body.workIds;
    if (body.coverImageId !== undefined) {
      row.coverImageId = body.coverImageId;
      row.coverManual = body.coverImageId !== null;
    }
    if (body.coverFocus !== undefined) row.coverFocus = body.coverFocus;
    if (body.pinned !== undefined) row.pinned = body.pinned;
    return this.withUndo(`已更新「${row.name}」`, () => {
      Object.assign(row, before);
    });
  }

  async markCharacterSeen(id: ID): Promise<void> {
    const row = this.requireCharacter(id);
    if (row.newCount === 0) return;
    row.newCount = 0;
    this.touch();
  }

  async mergeCharacter(id: ID, targetId: ID): Promise<MutationResult> {
    if (id === targetId) throw new BadRequestError('不能合并到自己');
    const from = this.requireCharacter(id);
    const to = this.requireCharacter(targetId);
    const toBefore = structuredClone(to);
    const touched: [ImageRow, ID[]][] = [];
    for (const img of this.db.images.values()) {
      if (!img.characterIds.includes(id)) continue;
      touched.push([img, [...img.characterIds]]);
      img.characterIds = [...new Set(img.characterIds.map((c) => (c === id ? targetId : c)))];
    }
    to.aliases = [...new Set([...to.aliases, from.name, ...from.aliases])];
    to.newCount += from.newCount;
    this.db.characters.delete(id);
    return this.withUndo(`已把「${from.name}」合并进「${to.name}」（${touched.length} 张）`, () => {
      this.db.characters.set(from.id, from);
      Object.assign(to, toBefore);
      for (const [img, ids] of touched) img.characterIds = ids;
    });
  }

  // ------------------------------------------------------------ 图片

  async listImages(query: ListImagesQuery): Promise<Page<ImageItem>> {
    const status = query.status;
    let rows = this.idx.visible.filter((img) => {
      const s = this.status(img);
      if (status ? s !== status : s === 'excluded') return false;
      if (query.characterId && !img.characterIds.includes(query.characterId)) return false;
      if (query.workId && !this.imageWorkIds(img).includes(query.workId)) return false;
      if (query.rating?.length && !query.rating.includes(img.rating)) return false;
      if (query.favorite !== undefined && img.favorite !== query.favorite) return false;
      if (query.original !== undefined && !!img.originalAt !== query.original) return false;
      if (query.artist && !img.artists?.some((a) => a.tag === query.artist)) return false;
      if (Array.isArray(query.kind) && query.kind.length && !query.kind.includes(kindOf(img))) return false;
      if (query.rated && !img.tagged) return false;
      if (query.collectionId === 'none' && img.collectionId) return false;
      if (query.collectionId !== undefined && query.collectionId !== 'none' && img.collectionId !== query.collectionId) return false;
      if (query.theme && !(img.tagged && matchesBrowseTheme(query.theme, img.tags.filter((t) => t.category === 'general')))) return false;
      if (query.tags?.length || query.tagsAll?.length || query.tagsNone?.length) {
        if (!img.tagged) return false;
        const has = new Set(img.tags.filter((t) => t.category === 'general' && t.score >= TAG_FILTER_MIN_SCORE).map((t) => t.tag));
        if (query.tags?.length && !query.tags.some((t) => has.has(t))) return false;
        if (query.tagsAll?.some((t) => !has.has(t))) return false;
        if (query.tagsNone?.some((t) => has.has(t))) return false;
      }
      if (query.orientation) {
        const ratio = img.width / img.height;
        const o = ratio > 1.05 ? 'landscape' : ratio < 0.95 ? 'portrait' : 'square';
        if (o !== query.orientation) return false;
      }
      if (query.q && !matchesQuery(query.q, [img.fileName, ...img.tags.map((t) => t.tag), ...this.nameKeysOf(img)])) return false;
      return true;
    });

    // page 只在看某一本时按页序，否则当入库时间
    const sort = query.sort === 'page' && (!query.collectionId || query.collectionId === 'none') ? 'addedAt' : (query.sort ?? 'addedAt');
    const dir = query.order === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case 'page':
          return ((a.pageNo ?? 0) - (b.pageNo ?? 0)) * dir || a.id.localeCompare(b.id) * dir;
        case 'fileName':
          return a.fileName.localeCompare(b.fileName) * dir;
        case 'bytes':
          return (a.bytes - b.bytes) * dir;
        case 'modifiedAt':
          return a.modifiedAt.localeCompare(b.modifiedAt) * dir;
        case 'random':
          return query.seed !== undefined
            ? hashString(a.id + ':' + query.seed) - hashString(b.id + ':' + query.seed)
            : hashString(a.id + 'seed') - hashString(b.id + 'seed');
        default:
          return a.addedAt.localeCompare(b.addedAt) * dir;
      }
    });
    const page = paginate(rows, query.cursor, query.limit);
    return { ...page, items: page.items.map((r) => this.toImage(r)) };
  }

  async getImage(id: ID): Promise<ImageDetail | null> {
    const row = this.db.images.get(id);
    if (!row || !this.isVisible(row)) return null;
    const root = this.db.settings.libraryRoots.find((r) => r.id === row.libraryRootId);
    return {
      ...this.toImage(row),
      absPath: `${root?.path ?? ''}/${row.relPath}`,
      tags: row.tags,
      characterSuggestions: this.suggestionsFor(row),
      kindSource: row.kindManual ? 'manual' : (row.kindSource ?? 'default'),
      kindReason: row.kindManual ? null : describeKindReason(row.kindSource ?? 'default', row.kindEvidence ?? null),
      collection: this.collections.ofImage(row),
      artists: [...(row.artists ?? [])]
        .sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
        .map((a) => ({ tag: a.tag, name: prettyTag(a.tag), tags: [a.tag] })),
      artistsManual: !!row.artistsManual,
    };
  }

  /** 「恢复自动判断」的结果：演示数据用分配时的类型，其余按规则现算 */
  private autoKindOf(img: ImageRow): { kind: ContentKind; source: ImageRow['kindSource']; evidence: string | null } {
    if (img.autoKind) return { kind: img.autoKind, source: img.kindSource === 'manual' ? 'tags' : (img.kindSource ?? 'tags'), evidence: null };
    const general = img.tags.filter((t) => t.category === 'general').map((t) => [t.tag, t.score] as [string, number]);
    const r = classifyContent({
      fileName: img.fileName,
      relPath: img.relPath,
      width: img.width,
      height: img.height,
      format: img.format,
      camera: null,
      tags: img.tagged ? new Map(general) : null,
    });
    return { kind: r.kind, source: r.source, evidence: r.evidence };
  }

  private setKind(rows: ImageRow[], value: ContentKind | 'auto'): void {
    for (const r of rows) {
      if (value === 'auto') {
        const a = this.autoKindOf(r);
        r.kind = a.kind;
        r.kindSource = a.source;
        r.kindEvidence = a.evidence;
        r.kindManual = false;
      } else {
        r.kind = value;
        r.kindSource = 'manual';
        r.kindEvidence = null;
        r.kindManual = true;
      }
    }
  }

  async updateImage(id: ID, body: UpdateImageBody): Promise<MutationResult> {
    const row = this.requireImage(id);
    const before = {
      characterIds: [...row.characterIds],
      rating: row.rating,
      favorite: row.favorite,
      kind: row.kind,
      kindSource: row.kindSource,
      kindEvidence: row.kindEvidence,
      kindManual: row.kindManual,
    };
    if (body.kind !== undefined) {
      assertKindValue(body.kind);
      this.setKind([row], body.kind);
    }
    if (body.characterIds) {
      for (const cid of body.characterIds) this.requireCharacter(cid);
      row.characterIds = [...new Set(body.characterIds)];
    }
    if (body.rating) row.rating = body.rating;
    if (body.favorite !== undefined) row.favorite = body.favorite;
    const msg =
      body.kind !== undefined
        ? body.kind === 'auto'
          ? '已恢复自动判断'
          : `已标为「${KIND_LABEL[body.kind]}」`
        : body.favorite !== undefined
          ? body.favorite
            ? '已收藏'
            : '已取消收藏'
          : body.rating
            ? '已修改分级'
            : '已更新角色';
    return this.withUndo(msg, () => {
      Object.assign(row, before);
    });
  }

  /** mock 只改记录，不碰文件；规则同 sqlite/move.ts */
  async moveImages(body: MoveImagesBody): Promise<MutationResult> {
    const root = this.db.settings.libraryRoots.find((r) => r.id === body.rootId);
    if (!root) throw new NotFoundError('图库文件夹');
    if (!root.enabled) throw new BadRequestError('这个图库文件夹停用了，先启用再移动');
    const dir = normalizeSubdir(body.dir);
    let rows: ImageRow[];
    if (body.characterId !== undefined) {
      const ch = this.requireCharacter(body.characterId);
      rows = [...this.db.images.values()].filter((i) => this.isVisible(i) && !i.excludedBy && i.characterIds.includes(ch.id));
    } else {
      rows = (body.ids ?? []).map((id) => this.requireImage(id));
    }
    if (!rows.length) throw new BadRequestError('没有可以移动的图');
    const used = new Set([...this.db.images.values()].filter((i) => i.libraryRootId === root.id).map((i) => i.relPath.toLowerCase()));
    const before = rows.map((r) => ({ r, rootId: r.libraryRootId, relPath: r.relPath, fileName: r.fileName }));
    let moved = 0;
    let inCollection = 0;
    let alreadyThere = 0;
    for (const r of rows) {
      if (r.collectionId) {
        inCollection++;
        continue;
      }
      const parent = r.relPath.includes('/') ? r.relPath.slice(0, r.relPath.lastIndexOf('/')) : '';
      if (r.libraryRootId === root.id && parent.toLowerCase() === dir.toLowerCase()) {
        alreadyThere++;
        continue;
      }
      const dot = r.fileName.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [r.fileName.slice(0, dot), r.fileName.slice(dot)] : [r.fileName, ''];
      let name = r.fileName;
      for (let n = 1; used.has((dir ? `${dir}/${name}` : name).toLowerCase()); n++) name = `${stem} (${n})${ext}`;
      r.libraryRootId = root.id;
      r.relPath = dir ? `${dir}/${name}` : name;
      r.fileName = name;
      used.add(r.relPath.toLowerCase());
      moved++;
    }
    const where = dir ? `${root.path.replace(/\/$/, '')}/${dir}` : root.path;
    const notes = [alreadyThere && `${alreadyThere} 张本来就在这里`, inCollection && `合集里的 ${inCollection} 张没动`].filter(Boolean);
    const message = `已移动 ${moved} 张到 ${where}${notes.length ? `（${notes.join('；')}）` : ''}`;
    if (!moved) return done(message);
    return this.withUndo(message, () => {
      for (const b of before) Object.assign(b.r, { libraryRootId: b.rootId, relPath: b.relPath, fileName: b.fileName });
    });
  }

  async bulkImages(body: BulkImagesBody): Promise<MutationResult> {
    if (!body.ids.length) throw new BadRequestError('没有选中任何图片');
    const rows = body.ids.map((id) => this.requireImage(id));
    const snapshots = rows.map((r) => ({
      row: r,
      characterIds: [...r.characterIds],
      excludedBy: r.excludedBy,
      favorite: r.favorite,
      rating: r.rating,
      trashed: r.trashed,
      kind: r.kind,
      kindSource: r.kindSource,
      kindEvidence: r.kindEvidence,
      kindManual: r.kindManual,
      shelvedAt: r.shelvedAt,
      originalAt: r.originalAt,
      copyrightWorkIds: [...r.copyrightWorkIds],
      artists: r.artists,
      artistsManual: r.artistsManual,
    }));
    const exclusionsBefore = [...this.db.exclusions];
    const n = rows.length;
    const action = body.action;
    let message: string;

    switch (action.type) {
      case 'assign': {
        const ch = this.requireCharacter(action.characterId);
        for (const r of rows) if (!r.characterIds.includes(ch.id)) r.characterIds = [...r.characterIds, ch.id];
        message = `已将 ${n} 张图归到「${ch.name}」`;
        break;
      }
      case 'unassign': {
        const ch = this.requireCharacter(action.characterId);
        for (const r of rows) r.characterIds = r.characterIds.filter((c) => c !== ch.id);
        message = `已从「${ch.name}」移除 ${n} 张图`;
        break;
      }
      case 'exclude': {
        for (const r of rows) {
          if (r.excludedBy) continue;
          const ex = {
            id: `x${this.db.exclusions.length + 1}_${r.id}`,
            kind: 'image' as const,
            target: r.id,
            label: `单张 · ${r.fileName}`,
            createdAt: new Date().toISOString(),
          };
          this.db.exclusions.push(ex);
          r.excludedBy = ex.id;
        }
        message = `已排除 ${n} 张图`;
        break;
      }
      case 'restore': {
        for (const r of rows) {
          const ex = this.db.exclusions.find((e) => e.id === r.excludedBy);
          if (ex?.kind === 'image') this.db.exclusions = this.db.exclusions.filter((e) => e !== ex);
          r.excludedBy = null;
        }
        message = `已恢复 ${n} 张图`;
        break;
      }
      case 'favorite':
        for (const r of rows) r.favorite = action.value;
        message = action.value ? `已收藏 ${n} 张图` : `已取消收藏 ${n} 张图`;
        break;
      case 'shelve': {
        const at = new Date(this.now).toISOString();
        for (const r of rows) r.shelvedAt = action.value ? at : null;
        message = action.value ? `已放下 ${n} 张图，不再出现在未识别` : `已把 ${n} 张图放回未识别`;
        break;
      }
      case 'original': {
        const at = new Date(this.now).toISOString();
        const wid = this.originalWorkId();
        for (const r of rows) {
          r.originalAt = action.value ? at : null;
          const rest = r.copyrightWorkIds.filter((w) => w !== wid);
          r.copyrightWorkIds = action.value ? [...rest, wid] : rest;
        }
        message = action.value ? `已把 ${n} 张图归为原创，不再出现在未识别` : `已把 ${n} 张图移出原创`;
        break;
      }
      case 'rating':
        for (const r of rows) r.rating = action.value;
        message = `已把 ${n} 张图设为「${RATING_LABEL[action.value]}」`;
        break;
      case 'kind':
        assertKindValue(action.value);
        this.setKind(rows, action.value);
        message = action.value === 'auto' ? `已恢复自动判断（${n} 张）` : `已把 ${n} 张图标为「${KIND_LABEL[action.value]}」`;
        break;
      case 'trash':
        for (const r of rows) r.trashed = true;
        message = `已把 ${n} 张图移到回收站`;
        break;
      case 'artist': {
        const tags = normArtists(action.mode, action.artists);
        for (const r of rows) {
          const cur = action.mode === 'set' ? [] : (r.artists ?? []).filter((a) => action.mode !== 'remove' || !tags.includes(a.tag));
          const add = action.mode === 'remove' ? [] : tags.filter((t) => !cur.some((a) => a.tag === t)).map((tag) => ({ tag, score: 1 }));
          r.artists = [...cur, ...add];
          r.artistsManual = true;
        }
        message = artistEditMessage(action.mode, n, tags.map(prettyTag));
        break;
      }
      case 'artist-auto': {
        // 只动手动改过的图
        const manual = rows.filter((r) => r.artistsManual);
        for (const r of manual) {
          r.artists = [];
          r.artistsManual = false;
        }
        message = artistAutoMessage(n, manual.length);
        break;
      }
    }

    return this.withUndo(message, () => {
      for (const s of snapshots) {
        s.row.characterIds = s.characterIds;
        s.row.excludedBy = s.excludedBy;
        s.row.favorite = s.favorite;
        s.row.rating = s.rating;
        s.row.trashed = s.trashed;
        s.row.kind = s.kind;
        s.row.kindSource = s.kindSource;
        s.row.kindEvidence = s.kindEvidence;
        s.row.kindManual = s.kindManual;
        s.row.shelvedAt = s.shelvedAt;
        s.row.originalAt = s.originalAt;
        s.row.copyrightWorkIds = s.copyrightWorkIds;
        s.row.artists = s.artists;
        s.row.artistsManual = s.artistsManual;
      }
      this.db.exclusions = exclusionsBefore;
    });
  }

  async getThumbnail(id: ID, width: ThumbWidth): Promise<FileResponse | null> {
    const row = this.db.images.get(id);
    if (!row) return null;
    return {
      kind: 'buffer',
      contentType: 'image/svg+xml',
      body: placeholderSvg({ id: row.seed, width: row.width, height: row.height, hue: row.hue, outWidth: width }),
    };
  }

  async getOriginal(id: ID): Promise<FileResponse | null> {
    const row = this.db.images.get(id);
    if (!row) return null;
    return {
      kind: 'buffer',
      contentType: 'image/svg+xml',
      body: placeholderSvg({ id: row.seed, width: row.width, height: row.height, hue: row.hue, outWidth: 1600, label: row.fileName }),
    };
  }

  async revealImage(id: ID): Promise<void> {
    this.requireImage(id);
    // mock：什么都不做。真实实现见 TASKS.md（Windows 上是 `explorer.exe /select,<path>`）
  }

  // ------------------------------------------------------------ 未识别

/** 与 sqlite 的 ROW 同口径的排序键（见 datasource/sqlite/unrecognized.ts） */
  private unrecRow(img: ImageRow) {
    const general = img.tags.filter((t) => t.category === 'general').map((t) => [t.tag, t.score] as [string, number]);
    const score = img.tagged ? artScore({ w: img.width, h: img.height, fileName: img.fileName }, general) : null;
    const stored = img.tagged ? classifyTheme(general, score) : null;
    const t = img.suggestions.length ? Math.max(...img.suggestions.map((x) => x[1])) : -1;
    return {
      img,
      a: img.addedAt,
      sh: img.shelvedAt ?? null,
      c: kindOf(img) === 'comic' ? 1 : 0,
      t,
      s: score ?? -999,
      th: resolveTheme({ kind: kindOf(img), rating: img.rating, theme: stored }) as UnrecognizedTheme,
      bucket: (img.shelvedAt
        ? 'shelved'
        : t >= 0
          ? 'suggested'
          : img.tagged || kindOf(img) === 'comic'
            ? 'unsure'
            : 'untagged') as 'shelved' | 'suggested' | 'unsure' | 'untagged',
    };
  }

  /** 插画和漫画：没有角色、不在合集里；照片、文字等：没有角色 */
  private unrecRows() {
    const base = this.idx.visible.filter((img) => !img.excludedBy && !img.characterIds.length && !img.originalAt);
    return {
      art: base.filter((img) => isArt(img) && !img.collectionId).map((img) => this.unrecRow(img)),
      annex: base.filter((img) => !isArt(img)).map((img) => this.unrecRow(img)),
    };
  }

  async unrecognizedSummary(): Promise<UnrecognizedSummary> {
    const { art, annex } = this.unrecRows();
    const themes = Object.fromEntries(UNRECOGNIZED_THEMES.map((t) => [t, 0])) as Record<UnrecognizedTheme, number>;
    const kinds = Object.fromEntries(UNRECOGNIZED_ANNEX_KINDS.map((k) => [k, 0])) as Record<UnrecognizedAnnexKind, number>;
    const n = { suggested: 0, unsure: 0, untagged: 0, shelved: 0 };
    for (const r of art) {
      n[r.bucket]++;
      if (r.bucket === 'unsure') themes[r.th]++;
    }
    for (const r of annex) kinds[kindOf(r.img) as UnrecognizedAnnexKind]++;
    const retaggable = art.filter((r) => !r.sh && r.img.tagged && kindOf(r.img) === 'illustration').length;
    return {
      art: { total: n.suggested + n.unsure + n.untagged, ...n, themes, retaggable },
      annex: { total: annex.length, kinds },
    };
  }

  /** mock：不改数据，只报张数并启动（模拟的）识别任务 */
  async retagUnrecognized(): Promise<RetagResult> {
    const { art } = await this.unrecognizedSummary();
    return { marked: art.retaggable, job: art.retaggable ? await this.startJob('tag') : null };
  }

  async listUnrecognized(query: ListUnrecognizedQuery): Promise<ListUnrecognizedResponse> {
    const sum = await this.unrecognizedSummary();
    const { art, annex } = this.unrecRows();
    const isAnnex = query.area === 'annex';
    // 参数和大类不匹配时一律忽略（theme 只在 art + unsure 时生效）
    const bucket = isAnnex ? null : (query.bucket ?? null);
    const theme = !isAnnex && bucket === 'unsure' ? (query.theme ?? null) : null;
    const kind = isAnnex ? (query.kind ?? null) : null;
    type R = ReturnType<typeof this.unrecRow>;
    const cmp = (x: string | null, y: string | null) => ((x ?? '') < (y ?? '') ? -1 : (x ?? '') > (y ?? '') ? 1 : 0);
    const byId = (x: R, y: R) => cmp(y.img.id, x.img.id);
    let rows: R[];
    let order: (x: R, y: R) => number;
    if (isAnnex) {
      rows = kind ? annex.filter((r) => kindOf(r.img) === kind) : annex;
      order = (x, y) => cmp(y.a, x.a) || byId(x, y);
    } else if (bucket === 'shelved') {
      rows = art.filter((r) => r.bucket === 'shelved');
      order = (x, y) => cmp(y.sh, x.sh) || byId(x, y);
    } else if (bucket === 'unsure') {
      rows = art.filter((r) => r.bucket === 'unsure' && (!theme || r.th === theme));
      order = (x, y) => x.c - y.c || y.s - x.s || byId(x, y);
    } else {
      rows = art.filter((r) => (bucket ? r.bucket === bucket : r.bucket !== 'shelved'));
      order = (x, y) => x.c - y.c || y.t - x.t || cmp(y.a, x.a) || byId(x, y);
    }
    rows.sort(order);
    const page = paginate(rows, query.cursor, query.limit);
    return {
      ...page,
      items: page.items.map((r) => ({ image: this.toImage(r.img), suggestions: this.suggestionsFor(r.img), tagged: r.img.tagged })),
      suggestedCount: sum.art.suggested,
      unsureCount: sum.art.unsure,
      untaggedCount: sum.art.untagged,
      annexCount: sum.annex.total,
    };
  }

  async acceptSuggestion(imageId: ID, danbooruTag: string): Promise<MutationResult> {
    const img = this.requireImage(imageId);
    let ch = this.idx.charByTag.get(danbooruTag);
    let created: CharacterRow | null = null;
    if (!ch) {
      created = {
        id: `c_${hashString(danbooruTag).toString(36)}`,
        name: humanizeTag(danbooruTag),
        danbooruTag,
        source: 'danbooru',
        aliases: [],
        workIds: [],
        newCount: 0,
        coverImageId: img.id,
        coverFocus: null,
        pinned: false,
      };
      this.db.characters.set(created.id, created);
      ch = created;
    }
    const before = [...img.characterIds];
    img.characterIds = [...new Set([...img.characterIds, ch.id])];
    const name = ch.name;
    return this.withUndo(created ? `已新建角色「${name}」并归入` : `已归到「${name}」`, () => {
      img.characterIds = before;
      if (created) this.db.characters.delete(created.id);
    });
  }

  // ------------------------------------------------------------ 重复

  async listDuplicates(query: ListDuplicatesQuery): Promise<DuplicateGroup[]> {
    const wantResolved = query.resolved ?? false;
    return this.db.duplicates
      .filter((d) => d.resolved === wantResolved)
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        similarity: d.similarity,
        images: d.imageIds.flatMap((id) => {
          const img = this.db.images.get(id);
          return img && (wantResolved || this.isVisible(img)) ? [this.toImage(img)] : [];
        }),
        suggestedKeepId: d.suggestedKeepId,
        suggestedKeepIds: [d.suggestedKeepId],
        resolved: d.resolved,
        setId: null,
      }))
      .filter((g) => g.images.length > (wantResolved ? 0 : 1))
      // 和 sqlite 一样：未处理的完全一样的在前，再按相似度从高到低（sort 是稳定的，同分保持原顺序）
      .sort((a, b) => (wantResolved ? 0 : Number(b.kind === 'exact') - Number(a.kind === 'exact') || b.similarity - a.similarity));
  }

  async resolveDuplicate(id: ID, keepIds: ID[]): Promise<MutationResult> {
    const group = this.db.duplicates.find((d) => d.id === id);
    if (!group) throw new NotFoundError('重复组');
    if (!keepIds.length) throw new BadRequestError('至少保留一张');
    if (keepIds.some((k) => !group.imageIds.includes(k))) throw new BadRequestError('保留的图不在这个重复组里');
    const trashed = group.imageIds.filter((iid) => !keepIds.includes(iid)).map((iid) => this.db.images.get(iid)!);
    for (const img of trashed) img.trashed = true;
    group.resolved = true;
    return this.withUndo(`已保留 ${keepIds.length} 张，${trashed.length} 张移到回收站`, () => {
      for (const img of trashed) img.trashed = false;
      group.resolved = false;
    });
  }

  async ignoreDuplicate(id: ID): Promise<MutationResult> {
    const group = this.db.duplicates.find((d) => d.id === id);
    if (!group) throw new NotFoundError('重复组');
    group.resolved = true;
    return this.withUndo('已标记为「不是重复」', () => {
      group.resolved = false;
    });
  }

  // ------------------------------------------------------------ 排除

  async listExclusions(): Promise<Exclusion[]> {
    const idx = this.idx;
    return [...this.db.exclusions]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((e) => ({
        ...e,
        imageCount: idx.exclusionCount.get(e.id) ?? 0,
        previewImageIds: idx.exclusionPreview.get(e.id) ?? [],
      }));
  }

  async createExclusion(body: CreateExclusionBody): Promise<MutationResult> {
    const target = body.target.trim();
    if (!target) throw new BadRequestError('排除目标不能为空');
    let label: string;
    let predicate: (img: ImageRow) => boolean;
    switch (body.kind) {
      case 'tag':
        label = `标签 · ${target}`;
        predicate = (img) => img.tags.some((t) => t.tag === target);
        break;
      case 'folder': {
        label = `文件夹 · ${target}`;
        const norm = target.replace(/\\/g, '/').replace(/\/$/, '');
        predicate = (img) => {
          const root = this.db.settings.libraryRoots.find((r) => r.id === img.libraryRootId);
          return `${root?.path}/${img.relPath}`.startsWith(norm + '/');
        };
        break;
      }
      case 'character': {
        const ch = this.requireCharacter(target);
        label = `角色 · ${ch.name}`;
        predicate = (img) => img.characterIds.includes(ch.id);
        break;
      }
      case 'image': {
        const img = this.requireImage(target);
        label = `单张 · ${img.fileName}`;
        predicate = (x) => x.id === img.id;
        break;
      }
    }
    const row = { id: `x${this.db.exclusions.length + 1}_${hashString(target).toString(36)}`, kind: body.kind, target, label, createdAt: new Date().toISOString() };
    this.db.exclusions.push(row);
    const affected: ImageRow[] = [];
    for (const img of this.db.images.values()) {
      if (!img.excludedBy && predicate(img)) {
        img.excludedBy = row.id;
        affected.push(img);
      }
    }
    return this.withUndo(`已排除：${label}（${affected.length} 张）`, () => {
      for (const img of affected) img.excludedBy = null;
      this.db.exclusions = this.db.exclusions.filter((e) => e !== row);
    });
  }

  async deleteExclusion(id: ID): Promise<MutationResult> {
    const row = this.db.exclusions.find((e) => e.id === id);
    if (!row) throw new NotFoundError('排除规则');
    const affected = [...this.db.images.values()].filter((img) => img.excludedBy === id);
    for (const img of affected) img.excludedBy = null;
    this.db.exclusions = this.db.exclusions.filter((e) => e !== row);
    return this.withUndo(`已恢复：${row.label}（${affected.length} 张）`, () => {
      this.db.exclusions.push(row);
      for (const img of affected) img.excludedBy = id;
    });
  }

  // ------------------------------------------------------------ 搜索

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const limit = query.limit ?? 20;
    const q = query.q.trim();
    if (!searchKey(q)) return []; // 空白、只有符号（如「_」）都算空查询
    // 给作品和标签各留名额，角色很多时它们也不会整组消失
    const chars: SearchHit[] = this.filterCharacters({ q })
      .sort((a, b) => b.imageCount - a.imageCount)
      .slice(0, Math.max(limit - 6, Math.ceil(limit / 2)))
      .map((character) => ({
        type: 'character',
        character,
        workName: this.db.works.get(character.workIds[0] ?? '')?.name ?? null,
      }));
    const works: SearchHit[] = [...this.db.works.values()]
      .filter((w) => matchesQuery(q, [w.name, w.danbooruTag, ...w.aliases]))
      .map((w) => this.toWork(w))
      .sort((a, b) => b.imageCount - a.imageCount)
      .slice(0, 3)
      .map((work) => ({ type: 'work', work }));
    const tags: SearchHit[] = [...this.idx.tagCount.entries()]
      .filter(([tag]) => matchesQuery(q, [tag]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, imageCount]) => ({ type: 'tag', tag, imageCount }));
    return [...chars, ...works, ...tags].slice(0, limit);
  }

  /** 一般标签联想：和 sqlite 同口径（张数只算分数达到 TAG_FILTER_MIN_SCORE 的；完全匹配排最前，其余按张数） */
  async tagSuggestions(query: TagSuggestionsQuery): Promise<TagSuggestion[]> {
    const limit = query.limit ?? 20;
    const k = searchKey(query.q?.trim() ?? '');
    const counts = new Map<string, number>();
    for (const img of this.idx.visible) {
      if (img.excludedBy) continue;
      for (const t of img.tags) {
        if (t.category === 'general' && t.score >= TAG_FILTER_MIN_SCORE) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([tag]) => !k || searchKey(tag).includes(k))
      .sort((a, b) => Number(searchKey(b[0]) === k) - Number(searchKey(a[0]) === k) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, name: tag.replace(/_/g, ' '), count }));
  }

  // ------------------------------------------------------------ 设置

  async getSettings(): Promise<Settings> {
    const counts = new Map<ID, number>();
    for (const img of this.db.images.values()) {
      if (!img.trashed && !img.excludedBy) counts.set(img.libraryRootId, (counts.get(img.libraryRootId) ?? 0) + 1);
    }
    const s = structuredClone(this.db.settings);
    for (const root of s.libraryRoots) root.imageCount = counts.get(root.id) ?? 0;
    return s;
  }

  async updateSettings(body: UpdateSettingsBody): Promise<Settings> {
    const s = this.db.settings;
    const { danbooruApiKey, ...rest } = body;
    const before = s.tagger.autoAcceptThreshold;
    if (rest.tagger) Object.assign(s.tagger, rest.tagger);
    // 调低自动采纳阈值：插画和漫画上已达标、库里已有这个角色的建议当场归入（与 sqlite 同口径）
    if (s.tagger.autoAcceptThreshold < before) {
      for (const img of this.db.images.values()) {
        if (img.trashed || !isArt(img) || !img.suggestions.length) continue;
        img.suggestions = img.suggestions.filter(([tag, score]) => {
          const ch = score >= s.tagger.autoAcceptThreshold ? this.idx.charByTag.get(tag) : undefined;
          if (!ch) return true;
          if (!img.characterIds.includes(ch.id)) img.characterIds = [...img.characterIds, ch.id];
          return false;
        });
      }
    }
    if (rest.danbooru) Object.assign(s.danbooru, rest.danbooru);
    if (rest.dedupe) Object.assign(s.dedupe, rest.dedupe);
    if (rest.ui) Object.assign(s.ui, rest.ui);
    if (rest.browse?.customThemes) s.browse.customThemes = structuredClone(rest.browse.customThemes);
    if (danbooruApiKey !== undefined) s.danbooru.hasApiKey = danbooruApiKey.length > 0;
    this.touch();
    return this.getSettings();
  }

  async addLibraryRoot(body: AddLibraryRootBody): Promise<MutationResult> {
    const path = body.path.trim().replace(/\\/g, '/').replace(/\/$/, '');
    if (!path) throw new BadRequestError('路径不能为空');
    const roots = this.db.settings.libraryRoots;
    if (roots.some((r) => r.path === path)) throw new BadRequestError('这个文件夹已经在图库里了');
    const inside = (child: string, parent: string) => child.toLowerCase().startsWith(parent.toLowerCase().replace(/\/?$/, '/'));
    const parent = roots.find((r) => inside(path, r.path));
    if (parent) throw new BadRequestError(`已经包含在「${parent.path}」里了，不用单独添加`);
    // 和 sqlite 一样：包含已有文件夹时先问，确认后把子文件夹的图接管过来（mock 没有「移除过的」文件夹）
    const children = roots.filter((r) => inside(r.path, path));
    if (children.length && !body.merge) {
      const disabled = children.filter((r) => !r.enabled).map((r) => `「${r.path}」`);
      throw new NeedsConfirmError(
        `这个文件夹包含图库里已有的${children.map((r) => `「${r.path}」`).join('')}，合并成一个吗？原来的识别和整理结果都会保留。` +
          (disabled.length ? `其中${disabled.join('')}现在是停用的，合并后会重新显示。` : ''),
      );
    }
    const root = { id: `root_${hashString(path).toString(36)}`, path, enabled: true, imageCount: 0, lastScanAt: null, importedAt: new Date().toISOString() };
    let merged = 0;
    for (const c of children) {
      const prefix = c.path.slice(path.length).replace(/^\/+/, '');
      for (const img of this.db.images.values()) {
        if (img.libraryRootId !== c.id) continue;
        img.libraryRootId = root.id;
        img.relPath = `${prefix}/${img.relPath}`;
        merged++;
      }
      for (const col of this.db.collections.values()) {
        if (col.rootId !== c.id) continue;
        col.rootId = root.id;
        col.relDir = col.relDir ? `${prefix}/${col.relDir}` : prefix;
      }
      roots.splice(roots.indexOf(c), 1);
      if (c.importedAt && c.importedAt < root.importedAt) root.importedAt = c.importedAt;
    }
    roots.push(root);
    this.touch();
    this.jobs.enqueue('scan');
    return done(
      children.length ? `已合并成一个文件夹（保留了 ${merged} 张图的整理结果），开始扫描其余部分：${path}` : `已添加文件夹，开始扫描：${path}`,
    );
  }

  async updateLibraryRoot(id: ID, enabled: boolean): Promise<MutationResult> {
    const root = this.db.settings.libraryRoots.find((r) => r.id === id);
    if (!root) throw new NotFoundError('图库文件夹');
    const before = root.enabled;
    root.enabled = enabled;
    return this.withUndo(enabled ? `已启用：${root.path}` : `已停用：${root.path}`, () => {
      root.enabled = before;
    });
  }

  async removeLibraryRoot(id: ID): Promise<MutationResult> {
    const idx = this.db.settings.libraryRoots.findIndex((r) => r.id === id);
    if (idx < 0) throw new NotFoundError('图库文件夹');
    const [root] = this.db.settings.libraryRoots.splice(idx, 1);
    return this.withUndo(`已移除文件夹（不会删除磁盘上的文件）：${root!.path}`, () => {
      this.db.settings.libraryRoots.splice(idx, 0, root!);
    });
  }

  // ------------------------------------------------------------ 后台任务

  async listJobs(): Promise<Job[]> {
    return this.jobs.list();
  }

  async startJob(kind: JobKind): Promise<Job> {
    return this.jobs.enqueue(kind);
  }

  async cancelJob(id: ID): Promise<void> {
    this.jobs.cancel(id);
  }

  /** mock 的后台任务：只模拟进度条，不改数据（扫描完成时刷新一下 lastScanAt）。 */
  private mockRunner(kind: JobKind): JobRunner {
    const totals: Record<JobKind, number> = {
      scan: 1800,
      thumbnail: 600,
      tag: this.idx.visible.filter((i) => !i.tagged).length || 240,
      'danbooru-sync': 120,
      artists: 0,
      dedupe: 900,
    };
    return async (ctx) => {
      const total = totals[kind];
      ctx.setTotal(total);
      const step = Math.max(1, Math.round(total / 60));
      for (let done = 0; done < total && !ctx.signal.aborted; done += step) {
        await new Promise((r) => setTimeout(r, 80));
        ctx.advance(Math.min(step, total - done), `${done + step >= total ? total : done + step} / ${total}`);
      }
      if (kind === 'scan') {
        for (const root of this.db.settings.libraryRoots) root.lastScanAt = new Date().toISOString();
      }
      if (kind === 'danbooru-sync') this.db.settings.danbooru.lastSyncAt = new Date().toISOString();
      if (kind === 'dedupe') this.db.settings.dedupe.lastRunAt = new Date().toISOString();
      this.index = null;
    };
  }

  // ------------------------------------------------------------ 撤销

  async undo(token: string): Promise<MutationResult> {
    return this.undoStack.run(token);
  }
}

// ------------------------------------------------------------ 小工具

function paginate<T>(all: T[], cursor: string | undefined, limit: number | undefined): Page<T> {
  const start = cursor ? Number(cursor) || 0 : 0;
  const size = Math.min(Math.max(limit ?? 60, 1), 200);
  const items = all.slice(start, start + size);
  const next = start + size;
  return { items, nextCursor: next < all.length ? String(next) : null, total: all.length };
}

/** mika_(blue_archive) → Mika */
function humanizeTag(tag: string): string {
  return tag
    .replace(/_\([^)]*\)$/, '')
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
