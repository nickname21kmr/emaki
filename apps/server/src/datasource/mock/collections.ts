/**
 * mock 的合集（T38c）：和 sqlite 的 CollectionQueries 同一套规则（摘要用 services/collections/summary.ts，
 * 页序用 detect.ts 的 orderPages），撤销用快照。
 */
import {
  searchKey,
  type BulkCollectionsBody,
  type Character,
  type CollectionKind,
  type CollectionSummary,
  type GetCollectionResponse,
  type ID,
  type ImageDetail,
  type ListCollectionsQuery,
  type MutationResult,
  type UpdateCollectionBody,
  type Work,
} from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { autoKind, bookLeaf, decideCollection, dirFeatures, orderPages, type DirPage } from '../../services/collections/detect.ts';
import { parseComicDir, parseFolderName } from '../../services/collections/parseName.ts';
import { summarize } from '../../services/collections/summary.ts';
import { mockDominantColor } from '../../util/color.ts';
import type { CharacterRow, CollectionRow, ImageRow, MockDb, WorkRow } from './fixtures.ts';

const KIND_LABEL: Record<CollectionKind, string> = { doujin: '本子', artbook: '画集' };
const isKind = (v: unknown): v is CollectionKind => v === 'doujin' || v === 'artbook';
const dirOf = (img: ImageRow) => (img.relPath.length > img.fileName.length ? img.relPath.slice(0, img.relPath.length - img.fileName.length - 1) : '');
const leafOf = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);
const collator = new Intl.Collator('ja', { numeric: true });
const compare = (a: CollectionSummary, b: CollectionSummary) =>
  (a.title === null ? 1 : 0) - (b.title === null ? 1 : 0) ||
  collator.compare(a.title ?? '', b.title ?? '') ||
  (a.volumeNo ?? 0) - (b.volumeNo ?? 0) ||
  a.id.localeCompare(b.id, 'en', { numeric: true });

export interface MockCollectionDeps {
  db: MockDb;
  now: number;
  /** 可见的图（文件夹启用、没进回收站） */
  visible: () => ImageRow[];
  imageWorkIds: (img: ImageRow) => ID[];
  toCharacter: (row: CharacterRow) => Character;
  toWork: (row: WorkRow) => Work;
  withUndo: (message: string, revert: () => void) => MutationResult;
}

interface Loaded {
  row: CollectionRow;
  summary: CollectionSummary;
  pages: ImageRow[];
  cast: { id: ID; pageCount: number; manual: boolean }[];
  works: { id: ID; pageCount: number; manual: boolean }[];
}

export class MockCollections {
  constructor(private readonly d: MockCollectionDeps) {}

  private toDirPage(img: ImageRow): DirPage {
    return {
      id: Number(img.id.slice(1)) || 0,
      fileName: img.fileName,
      width: img.width,
      height: img.height,
      modifiedAt: img.modifiedAt,
      kind: img.kind ?? 'illustration',
      judged: img.tagged || !!img.kindManual || (!!img.kindSource && img.kindSource !== 'default'),
    };
  }

  private loadAll(): Map<ID, Loaded> {
    const counted = this.d.visible().filter((img) => !img.excludedBy);
    const pagesBy = new Map<ID, ImageRow[]>();
    for (const img of counted) {
      if (!img.collectionId) continue;
      pagesBy.set(img.collectionId, [...(pagesBy.get(img.collectionId) ?? []), img]);
    }
    const out = new Map<ID, Loaded>();
    for (const row of this.d.db.collections.values()) {
      if (row.state !== 'active') continue;
      const root = this.d.db.settings.libraryRoots.find((r) => r.id === row.rootId);
      if (!root?.enabled) continue;
      // 按漫画导入的文件夹里的书：不找角色（不算待整理），分级可信（同 sqlite）
      const comic = root.mode === 'comic';
      const pages = (pagesBy.get(row.id) ?? []).sort((a, b) => (a.pageNo ?? 0) - (b.pageNo ?? 0));
      const charHits = new Map<ID, number>();
      const workHits = new Map<ID, number>();
      for (const p of pages) {
        for (const c of p.characterIds) charHits.set(c, (charHits.get(c) ?? 0) + 1);
        for (const w of this.d.imageWorkIds(p)) workHits.set(w, (workHits.get(w) ?? 0) + 1);
      }
      const s = summarize<ID>({
        kind: row.kind,
        coverImageId: row.coverImageId,
        reviewed: row.reviewedAt !== null || comic,
        pages: pages.map((p) => ({
          id: p.id,
          width: p.width,
          height: p.height,
          rating: p.rating,
          kind: p.kind ?? 'illustration',
          color: mockDominantColor(p.hue, p.id),
          tagged: p.tagged || comic,
          addedAt: p.addedAt,
          hasChar: p.characterIds.length > 0,
        })),
        charHits,
        workHits,
        manualChars: row.manualCharacterIds,
        manualWorks: row.manualWorkIds,
        worksOfCharacter: (id) => this.d.db.characters.get(id)?.workIds ?? [],
      });
      out.set(row.id, {
        row,
        pages,
        cast: s.cast,
        works: s.works,
        summary: {
          id: row.id,
          kind: row.kind,
          title: row.title,
          folderName: leafOf(row.relDir),
          event: row.event,
          circle: row.circle,
          artist: row.artist,
          parody: row.parody,
          translator: row.translator,
          seriesKey: row.seriesKey,
          volumeNo: row.volumeNo,
          pageCount: s.pageCount,
          covers: s.covers.map((c) => ({ imageId: c.imageId, rating: c.rating, color: c.color, focus: null })),
          coverTagged: s.coverTagged,
          origin: row.origin,
          pending: s.pending,
          unrecognizedPageCount: s.unrecognizedPageCount,
          lastAddedAt: s.lastAddedAt,
        },
      });
    }
    return out;
  }

  list(q: ListCollectionsQuery): CollectionSummary[] {
    const k = q.q ? searchKey(q.q) : '';
    const out: CollectionSummary[] = [];
    for (const l of this.loadAll().values()) {
      const s = l.summary;
      if (s.pageCount === 0) continue;
      if (q.kind && s.kind !== q.kind) continue;
      if (q.seriesKey !== undefined && s.seriesKey !== q.seriesKey) continue;
      if (q.pending !== undefined && s.pending !== q.pending) continue;
      if (k && ![s.title ?? '', s.folderName, s.circle, s.artist, s.parody, s.translator].some((x) => x && searchKey(x).includes(k))) continue;
      let match: number | undefined;
      if (q.characterId !== undefined) {
        const hit = l.cast.find((c) => c.id === q.characterId);
        if (!hit) continue;
        match = hit.pageCount;
      }
      if (q.workId !== undefined) {
        const hit = l.works.find((w) => w.id === q.workId);
        if (!hit) continue;
        match = hit.pageCount;
      }
      out.push(match === undefined ? s : { ...s, matchPageCount: match });
    }
    return out.sort(compare);
  }

  get(id: ID): GetCollectionResponse | null {
    const all = this.loadAll();
    const l = all.get(id);
    if (!l) return null;
    const root = this.d.db.settings.libraryRoots.find((r) => r.id === l.row.rootId);
    return {
      collection: l.summary,
      pages: l.pages.map((p, i) => ({
        imageId: p.id,
        pageNo: i + 1,
        width: p.width,
        height: p.height,
        rating: p.rating,
        kind: p.kind ?? 'illustration',
        dominantColor: mockDominantColor(p.hue, p.id),
        tagged: p.tagged || root?.mode === 'comic',
      })),
      cast: l.cast.flatMap((c) => {
        const row = this.d.db.characters.get(c.id);
        return row ? [{ character: this.d.toCharacter(row), pageCount: c.pageCount, manual: c.manual }] : [];
      }),
      works: l.works.flatMap((w) => {
        const row = this.d.db.works.get(w.id);
        return row ? [{ work: this.d.toWork(row), pageCount: w.pageCount, manual: w.manual }] : [];
      }),
      folderPath: `${root?.path ?? ''}/${l.row.relDir}`,
      pageOrder: l.row.pageOrder,
      evidence: l.row.evidence,
      reviewed: l.row.reviewedAt !== null,
      series: l.row.seriesKey
        ? [...all.values()]
            .filter((x) => x.row.seriesKey === l.row.seriesKey && x.summary.pageCount > 0)
            .map((x) => x.summary)
            .sort((a, b) => (a.volumeNo ?? 0) - (b.volumeNo ?? 0) || compare(a, b))
        : [],
    };
  }

  stats(): { collectionCounts: Record<CollectionKind, number>; pendingCollectionCount: number } {
    const counts: Record<CollectionKind, number> = { doujin: 0, artbook: 0 };
    const pending = new Set<string>();
    for (const { summary: s } of this.loadAll().values()) {
      if (s.pageCount === 0) continue;
      counts[s.kind]++;
      if (s.pending) pending.add(s.seriesKey ?? `c${s.id}`);
    }
    return { collectionCounts: counts, pendingCollectionCount: pending.size };
  }

  /** 看图器「收录于」：pageNo 是可见页里的序号 */
  ofImage(img: ImageRow): ImageDetail['collection'] {
    if (!img.collectionId) return null;
    const l = this.loadAll().get(img.collectionId);
    if (!l) return null;
    const i = l.pages.findIndex((p) => p.id === img.id);
    return {
      id: l.row.id,
      kind: l.row.kind,
      title: l.row.title,
      pageNo: Math.max(1, i + 1),
      pageCount: l.pages.length,
      volumeNo: l.row.volumeNo,
      folderName: leafOf(l.row.relDir),
    };
  }

  // ---------------------------------------------------------------- 修改

  /** 一个目录下的直接成员（可见、未排除） */
  private members(rootId: ID, dir: string): ImageRow[] {
    return this.d.visible().filter((img) => !img.excludedBy && img.libraryRootId === rootId && dirOf(img) === dir);
  }

  /** 按页序重新编号；这本之外的页离开合集 */
  private assignPages(c: CollectionRow): ImageRow[] {
    const members = this.members(c.rootId, c.relDir);
    const ordered = orderPages(
      members.map((img) => ({ ...this.toDirPage(img), img })),
      c.pageOrder,
    ).map((x) => x.img);
    for (const img of this.d.db.images.values()) {
      if (img.collectionId === c.id && !ordered.includes(img)) {
        img.collectionId = null;
        img.pageNo = null;
      }
    }
    ordered.forEach((img, i) => {
      img.collectionId = c.id;
      img.pageNo = i + 1;
    });
    return ordered;
  }

  private snapshot(ids: ID[]) {
    const rows = ids.map((id) => ({ ...this.d.db.collections.get(id)! }));
    const pages = [...this.d.db.images.values()].map((img) => ({ img, collectionId: img.collectionId, pageNo: img.pageNo }));
    return () => {
      for (const r of rows) this.d.db.collections.set(r.id, { ...r });
      for (const p of pages) {
        p.img.collectionId = p.collectionId;
        p.img.pageNo = p.pageNo;
      }
    };
  }

  private requireActive(id: ID): CollectionRow {
    const row = this.d.db.collections.get(id);
    if (!row || row.state !== 'active') throw new NotFoundError('合集');
    return row;
  }

  private isComicRoot(rootId: ID): boolean {
    return this.d.db.settings.libraryRoots.some((r) => r.id === rootId && r.mode === 'comic');
  }

  /** 自动的书名、系列、卷号（同 sqlite 的 CollectionQueries.parsedFor） */
  private parsedFor(rootId: ID, dir: string) {
    const root = this.d.db.settings.libraryRoots.find((r) => r.id === rootId);
    return root?.mode === 'comic' ? parseComicDir(dir, root.path) : parseFolderName(bookLeaf(dir));
  }

  create(body: { fromImageId: ID; kind: CollectionKind }): MutationResult & { collection: CollectionSummary } {
    if (!isKind(body.kind)) throw new BadRequestError('类型只能是本子或画集');
    const img = this.d.db.images.get(body.fromImageId);
    if (!img || !this.d.visible().includes(img)) throw new NotFoundError('图片');
    const dir = dirOf(img);
    if (!dir && !this.isComicRoot(img.libraryRootId)) throw new BadRequestError('图库根目录里的图不能成册');
    const ex = [...this.d.db.collections.values()].find((c) => c.rootId === img.libraryRootId && c.relDir === dir);
    if (ex?.state === 'active') throw new ConflictError('这个文件夹已经是合集');
    const at = new Date(this.d.now).toISOString();
    const restore = this.snapshot(ex ? [ex.id] : []);
    let row: CollectionRow;
    if (ex) {
      Object.assign(ex, { state: 'active', kind: body.kind, kindManual: true, kindSource: 'manual', origin: 'manual', updatedAt: at });
      row = ex;
    } else {
      const leaf = bookLeaf(dir);
      const p = this.parsedFor(img.libraryRootId, dir);
      const members = this.members(img.libraryRootId, dir);
      const next = Math.max(0, ...[...this.d.db.collections.keys()].map((k) => Number(k.replace(/\D/g, '')) || 0)) + 1;
      row = {
        id: `col${next}`,
        rootId: img.libraryRootId,
        relDir: dir,
        kind: body.kind,
        kindSource: 'manual',
        kindManual: true,
        title: p.title,
        titleManual: false,
        event: p.event,
        circle: p.circle,
        artist: p.artist,
        parody: p.parody,
        translator: p.translator,
        seriesKey: p.seriesKey,
        volumeNo: p.volumeNo,
        seriesManual: false,
        pageOrder: decideCollection(leaf, dirFeatures(members.map((m) => this.toDirPage(m))))?.pageOrder ?? 'name',
        coverImageId: null,
        origin: 'manual',
        state: 'active',
        evidence: '手动成册',
        reviewedAt: null,
        createdAt: at,
        updatedAt: at,
        manualCharacterIds: [],
        manualWorkIds: [],
      };
      this.d.db.collections.set(row.id, row);
    }
    const n = this.assignPages(row).length;
    const created = !ex;
    const id = row.id;
    const result = this.d.withUndo(`已把「${leafOf(dir)}」做成${KIND_LABEL[body.kind]}（${n} 页）`, () => {
      restore();
      if (created) this.d.db.collections.delete(id);
    });
    return { ...result, collection: this.loadAll().get(id)!.summary };
  }

  update(id: ID, body: UpdateCollectionBody): MutationResult {
    const c = this.requireActive(id);
    const leaf = bookLeaf(c.relDir);
    const notes: string[] = [];
    const next: Partial<CollectionRow> = {};
    let reorder = false;
    if (body.title !== undefined) {
      if (body.title === null) {
        Object.assign(next, { title: this.parsedFor(c.rootId, c.relDir).title, titleManual: false });
        notes.push('已恢复自动名');
      } else {
        const t = body.title.trim();
        if (!t) throw new BadRequestError('名字不能为空');
        Object.assign(next, { title: t.normalize('NFC'), titleManual: true });
        notes.push(`已改名为《${t}》`);
      }
    }
    if (body.kind !== undefined) {
      if (body.kind === 'auto') {
        const pages = this.members(c.rootId, c.relDir).map((m) => this.toDirPage(m));
        const f = dirFeatures(pages);
        const rule = this.isComicRoot(c.rootId) ? 'H' : pages.length ? (decideCollection(leaf, f)?.rule ?? null) : null;
        const k = autoKind(leaf, f, rule);
        Object.assign(next, { kind: k.kind, kindSource: k.source, kindManual: false });
        notes.push(`已恢复自动判断（${KIND_LABEL[k.kind]}）`);
      } else {
        if (!isKind(body.kind)) throw new BadRequestError('类型只能是本子或画集');
        Object.assign(next, { kind: body.kind, kindSource: 'manual', kindManual: true });
        notes.push(`已改为${KIND_LABEL[body.kind]}`);
      }
    }
    if (body.coverImageId !== undefined) {
      if (body.coverImageId !== null && this.d.db.images.get(body.coverImageId)?.collectionId !== c.id) {
        throw new BadRequestError('封面必须是这本里的一页');
      }
      next.coverImageId = body.coverImageId;
      notes.push(body.coverImageId === null ? '已恢复自动封面' : '已换封面');
    }
    if (body.pageOrder !== undefined) {
      next.pageOrder = body.pageOrder;
      reorder = true;
      notes.push(body.pageOrder === 'name' ? '已改为按文件名排页' : '已改为按修改时间排页');
    }
    if (body.seriesKey !== undefined || body.volumeNo !== undefined) {
      if (body.seriesKey === null) {
        const p = this.parsedFor(c.rootId, c.relDir);
        Object.assign(next, { seriesKey: p.seriesKey, volumeNo: p.volumeNo, seriesManual: false });
      } else {
        Object.assign(next, {
          seriesKey: body.seriesKey !== undefined ? body.seriesKey.trim() || null : c.seriesKey,
          volumeNo: body.volumeNo !== undefined ? body.volumeNo : c.volumeNo,
          seriesManual: true,
        });
      }
      notes.push('已更新系列');
    }
    if (body.reviewed !== undefined) {
      next.reviewedAt = body.reviewed ? new Date(this.d.now).toISOString() : null;
      notes.push(body.reviewed ? '已标为已整理' : '已标为待整理');
    }
    if (body.manualCharacterIds) {
      for (const x of body.manualCharacterIds) if (!this.d.db.characters.has(x)) throw new NotFoundError('角色');
      next.manualCharacterIds = [...new Set(body.manualCharacterIds)];
      notes.push('已更新出场角色');
    }
    if (body.manualWorkIds) {
      for (const x of body.manualWorkIds) if (!this.d.db.works.has(x)) throw new NotFoundError('作品');
      next.manualWorkIds = [...new Set(body.manualWorkIds)];
      notes.push('已更新作品');
    }
    if (!notes.length) throw new BadRequestError('没有要修改的内容');
    const restore = this.snapshot([c.id]);
    Object.assign(c, next, { origin: 'manual', updatedAt: new Date(this.d.now).toISOString() });
    if (reorder) this.assignPages(c);
    return this.d.withUndo(notes.join('，'), restore);
  }

  dismiss(id: ID): MutationResult {
    const c = this.requireActive(id);
    const restore = this.snapshot([c.id]);
    Object.assign(c, { state: 'dismissed', origin: 'manual', updatedAt: new Date(this.d.now).toISOString() });
    for (const img of this.d.db.images.values()) {
      if (img.collectionId === c.id) {
        img.collectionId = null;
        img.pageNo = null;
      }
    }
    return this.d.withUndo(`已取消成册：${c.title ?? '无题'}`, restore);
  }

  bulk(body: BulkCollectionsBody): MutationResult {
    const rows = [...new Set(body.ids)].map((x) => this.requireActive(x));
    const a = body.action;
    if (a.type === 'addCharacter' && !this.d.db.characters.has(a.characterId)) throw new NotFoundError('角色');
    if (a.type === 'addWork' && !this.d.db.works.has(a.workId)) throw new NotFoundError('作品');
    if (a.type === 'kind' && !isKind(a.value)) throw new BadRequestError('类型只能是本子或画集');
    const restore = this.snapshot(rows.map((r) => r.id));
    const at = new Date(this.d.now).toISOString();
    for (const r of rows) {
      r.origin = 'manual';
      r.updatedAt = at;
      if (a.type === 'review') r.reviewedAt = at;
      else if (a.type === 'kind') Object.assign(r, { kind: a.value, kindSource: 'manual', kindManual: true });
      else if (a.type === 'addCharacter' && !r.manualCharacterIds.includes(a.characterId)) r.manualCharacterIds = [...r.manualCharacterIds, a.characterId];
      else if (a.type === 'addWork' && !r.manualWorkIds.includes(a.workId)) r.manualWorkIds = [...r.manualWorkIds, a.workId];
    }
    const n = rows.length;
    const message =
      a.type === 'review'
        ? `已把 ${n} 本标为已整理`
        : a.type === 'kind'
          ? `已把 ${n} 本改为${KIND_LABEL[a.value]}`
          : `已把 ${n} 本关联到「${a.type === 'addCharacter' ? this.d.db.characters.get(a.characterId)!.name : this.d.db.works.get(a.workId)!.name}」`;
    return this.d.withUndo(message, restore);
  }
}
