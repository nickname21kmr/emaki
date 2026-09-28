/**
 * 合集的查询与修改（T38c）。摘要统一由 loadSummaries 算（口径在 services/collections/summary.ts，和 mock 共用）。
 * 写操作全部走 ctx.mutate，任何写都把合集转成 origin='manual'（自动判定不会再删它）。
 */
import {
  searchKey,
  type BulkCollectionsBody,
  type CollectionKind,
  type CollectionPage,
  type CollectionSummary,
  type ContentKind,
  type GetCollectionResponse,
  type ID,
  type ListCollectionsQuery,
  type MutationResult,
  type Rating,
  type UpdateCollectionBody,
} from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import type { CollectionRow, CollectionService } from '../../services/collections/CollectionService.ts';
import { autoKind, decideCollection, dirFeatures, isJudged, type DirPage } from '../../services/collections/detect.ts';
import { parseFolderName } from '../../services/collections/parseName.ts';
import { summarize } from '../../services/collections/summary.ts';
import type { SqliteContext } from './context.ts';
import type { Derived } from './derived.ts';
import { toCharacter, toWork } from './library.ts';
import { DEFAULT_DOMINANT, iso, parseId, toId, VISIBLE } from './sql.ts';
import type { UndoRecorder } from './undo.ts';

const KIND_LABEL: Record<CollectionKind, string> = { doujin: '本子', artbook: '画集' };
const isKind = (v: unknown): v is CollectionKind => v === 'doujin' || v === 'artbook';
/** 可变列（撤销时整行记下这些） */
const MUTABLE = [
  'kind', 'kind_source', 'kind_manual', 'title', 'title_manual', 'series_key', 'volume_no', 'series_manual', 'page_order',
  'cover_image_id', 'origin', 'state', 'evidence', 'reviewed_at', 'updated_at',
];

interface PageRow {
  id: number;
  collection_id: number;
  page_no: number;
  width: number;
  height: number;
  rating: Rating;
  content_kind: ContentKind;
  dominant_color: string | null;
  tagged_at: string | null;
  added_at: string;
  has_char: number;
}

interface Loaded {
  row: CollectionRow & { root_path: string };
  summary: CollectionSummary;
  pages: PageRow[];
  cast: { id: number; pageCount: number; manual: boolean }[];
  works: { id: number; pageCount: number; manual: boolean }[];
}

const leafOf = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);
const collator = new Intl.Collator('ja', { numeric: true });
/** 列表排序：无题排最后，其余按标题、卷号、id */
export const compareSummaries = (a: CollectionSummary, b: CollectionSummary) =>
  (a.title === null ? 1 : 0) - (b.title === null ? 1 : 0) ||
  collator.compare(a.title ?? '', b.title ?? '') ||
  (a.volumeNo ?? 0) - (b.volumeNo ?? 0) ||
  Number(a.id) - Number(b.id);

/** RV-C-15：一个目录下的直接成员（不含子目录），不用 LIKE */
const DIR_MEMBERS = `SELECT i.id, i.file_name, i.width, i.height, i.modified_at, i.content_kind, i.content_kind_source, i.content_kind_manual, i.tagged_at
  FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE ${VISIBLE} AND i.excluded_by IS NULL AND i.root_id = @root
    AND substr(i.rel_path, 1, length(@dir) + 1) = @dir || '/' AND instr(substr(i.rel_path, length(@dir) + 2), '/') = 0`;

export class CollectionQueries {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly service: CollectionService,
    private readonly derived: Derived,
  ) {}

  /** 4.1：全部 active 合集的摘要 */
  private loadAll(): Map<number, Loaded> {
    const db = this.ctx.db;
    const rows = db
      .prepare(
        `SELECT c.*, r.path AS root_path FROM collections c JOIN library_roots r ON r.id = c.root_id
         WHERE c.state = 'active' AND r.enabled = 1 AND r.removed_at IS NULL`,
      )
      .all() as (CollectionRow & { root_path: string })[];
    const pagesBy = new Map<number, PageRow[]>();
    for (const p of db
      .prepare(
        `SELECT i.id, i.collection_id, i.page_no, i.width, i.height, i.rating, i.content_kind, i.dominant_color, i.tagged_at, i.added_at,
                EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id) AS has_char
         FROM v_counted_images i WHERE i.collection_id IS NOT NULL ORDER BY i.collection_id, i.page_no`,
      )
      .all() as PageRow[]) {
      const list = pagesBy.get(p.collection_id);
      if (list) list.push(p);
      else pagesBy.set(p.collection_id, [p]);
    }
    const hits = (sql: string) => {
      const m = new Map<number, Map<number, number>>();
      for (const r of db.prepare(sql).all() as { c: number; x: number; n: number }[]) {
        const inner = m.get(r.c) ?? new Map<number, number>();
        inner.set(r.x, r.n);
        m.set(r.c, inner);
      }
      return m;
    };
    const charHits = hits(
      `SELECT i.collection_id AS c, ic.character_id AS x, COUNT(*) AS n FROM v_counted_images i
       JOIN image_characters ic ON ic.image_id = i.id WHERE i.collection_id IS NOT NULL GROUP BY 1, 2`,
    );
    // 与 v_image_works 同口径（经角色的作品 ∪ image_copyrights），但直接连底表：
    // 连视图时 SQLite 会把整个 UNION 视图对每一行重扫一遍，副本上要 11 秒
    const workHits = hits(
      `SELECT c, x, COUNT(*) AS n FROM (
         SELECT i.collection_id AS c, i.id AS iid, cw.work_id AS x FROM v_counted_images i
           JOIN image_characters ic ON ic.image_id = i.id JOIN character_works cw ON cw.character_id = ic.character_id
           WHERE i.collection_id IS NOT NULL
         UNION
         SELECT i.collection_id, i.id, ico.work_id FROM v_counted_images i
           JOIN image_copyrights ico ON ico.image_id = i.id
           WHERE i.collection_id IS NOT NULL)
       GROUP BY c, x`,
    );
    const manual = (table: string, col: string) => {
      const m = new Map<number, number[]>();
      for (const r of db.prepare(`SELECT collection_id AS c, ${col} AS x FROM ${table} ORDER BY added_at, ${col}`).all() as {
        c: number;
        x: number;
      }[])
        m.set(r.c, [...(m.get(r.c) ?? []), r.x]);
      return m;
    };
    const manualChars = manual('collection_characters', 'character_id');
    const manualWorks = manual('collection_works', 'work_id');
    const chars = this.derived.get().characters;

    const out = new Map<number, Loaded>();
    for (const row of rows) {
      const pages = pagesBy.get(row.id) ?? [];
      const s = summarize<number>({
        kind: row.kind as CollectionKind,
        coverImageId: row.cover_image_id,
        reviewed: row.reviewed_at !== null,
        pages: pages.map((p) => ({
          id: p.id,
          width: p.width,
          height: p.height,
          rating: p.rating,
          kind: p.content_kind,
          color: p.dominant_color,
          tagged: p.tagged_at !== null,
          addedAt: p.added_at,
          hasChar: p.has_char === 1,
        })),
        charHits: charHits.get(row.id) ?? new Map(),
        workHits: workHits.get(row.id) ?? new Map(),
        manualChars: manualChars.get(row.id) ?? [],
        manualWorks: manualWorks.get(row.id) ?? [],
        worksOfCharacter: (id) => chars.get(id)?.workIds ?? [],
      });
      out.set(row.id, {
        row,
        pages,
        cast: s.cast,
        works: s.works,
        summary: {
          id: toId(row.id),
          kind: row.kind as CollectionKind,
          title: row.title,
          folderName: leafOf(row.rel_dir),
          event: row.event,
          circle: row.circle,
          artist: row.artist,
          parody: row.parody,
          translator: row.translator,
          seriesKey: row.series_key,
          volumeNo: row.volume_no,
          pageCount: s.pageCount,
          covers: s.covers.map((c) => ({ imageId: toId(c.imageId), rating: c.rating, color: c.color ?? DEFAULT_DOMINANT, focus: null })),
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
    const cid = q.characterId !== undefined ? parseId(q.characterId) : null;
    const wid = q.workId !== undefined ? parseId(q.workId) : null;
    if ((q.characterId !== undefined && cid === null) || (q.workId !== undefined && wid === null)) return [];
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
      if (cid !== null) {
        const hit = l.cast.find((c) => c.id === cid);
        if (!hit) continue;
        match = hit.pageCount;
      }
      if (wid !== null) {
        const hit = l.works.find((w) => w.id === wid);
        if (!hit) continue;
        match = hit.pageCount;
      }
      out.push(match === undefined ? s : { ...s, matchPageCount: match });
    }
    return out.sort(compareSummaries);
  }

  get(idStr: ID): GetCollectionResponse | null {
    const id = parseId(idStr);
    const all = this.loadAll();
    const l = id === null ? undefined : all.get(id);
    if (!l) return null;
    const data = this.derived.get();
    const pages: CollectionPage[] = l.pages.map((p, i) => ({
      imageId: toId(p.id),
      pageNo: i + 1,
      width: p.width,
      height: p.height,
      rating: p.rating,
      kind: p.content_kind,
      dominantColor: p.dominant_color ?? DEFAULT_DOMINANT,
      tagged: p.tagged_at !== null,
    }));
    const series = l.row.series_key
      ? [...all.values()]
          .filter((x) => x.row.series_key === l.row.series_key && x.summary.pageCount > 0)
          .map((x) => x.summary)
          .sort((a, b) => (a.volumeNo ?? 0) - (b.volumeNo ?? 0) || Number(a.id) - Number(b.id))
      : [];
    return {
      collection: l.summary,
      pages,
      cast: l.cast.flatMap((c) => {
        const rec = data.characters.get(c.id);
        return rec ? [{ character: toCharacter(rec), pageCount: c.pageCount, manual: c.manual }] : [];
      }),
      works: l.works.flatMap((w) => {
        const rec = data.works.get(w.id);
        return rec ? [{ work: toWork(rec), pageCount: w.pageCount, manual: w.manual }] : [];
      }),
      folderPath: `${l.row.root_path}/${l.row.rel_dir}`,
      pageOrder: l.row.page_order,
      evidence: l.row.evidence,
      reviewed: l.row.reviewed_at !== null,
      series,
    };
  }

  /** getStats 用：页数 > 0 的本数，和待整理条目数（同一系列算一条） */
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

  // ---------------------------------------------------------------- 修改

  create(body: { fromImageId: ID; kind: CollectionKind }): MutationResult & { collection: CollectionSummary } {
    if (!isKind(body.kind)) throw new BadRequestError('类型只能是本子或画集');
    const iid = parseId(body.fromImageId);
    const img =
      iid === null
        ? undefined
        : (this.ctx.db
            .prepare(`SELECT i.root_id, i.rel_path, i.file_name FROM images i JOIN library_roots r ON r.id = i.root_id WHERE i.id = ? AND ${VISIBLE}`)
            .get(iid) as { root_id: number; rel_path: string; file_name: string } | undefined);
    if (!img) throw new NotFoundError('图片');
    const dir = img.rel_path.length > img.file_name.length ? img.rel_path.slice(0, img.rel_path.length - img.file_name.length - 1) : '';
    if (!dir) throw new BadRequestError('图库根目录里的图不能成册');
    const db = this.ctx.db;
    const ex = db.prepare('SELECT * FROM collections WHERE root_id = ? AND rel_dir = ?').get(img.root_id, dir) as CollectionRow | undefined;
    if (ex?.state === 'active') throw new ConflictError('这个文件夹已经是合集');
    const now = iso(this.ctx.clock());
    const members = this.members(img.root_id, dir);
    let collectionId = 0;
    const result = this.ctx.mutate((u) => {
      if (ex) {
        u.columns('collections', MUTABLE, [ex.id]);
        db.prepare(
          `UPDATE collections SET state = 'active', kind = ?, kind_manual = 1, kind_source = 'manual', origin = 'manual', updated_at = ? WHERE id = ?`,
        ).run(body.kind, now, ex.id);
        collectionId = ex.id;
      } else {
        const leaf = leafOf(dir);
        const p = parseFolderName(leaf);
        const order = decideCollection(leaf, dirFeatures(members.map((m) => m.page)))?.pageOrder ?? 'name';
        collectionId = Number(
          db
            .prepare(
              `INSERT INTO collections (root_id, rel_dir, kind, kind_source, kind_manual, title, event, circle, artist, parody, translator,
                 series_key, volume_no, page_order, origin, state, evidence, created_at, updated_at)
               VALUES (@root, @dir, @kind, 'manual', 1, @title, @event, @circle, @artist, @parody, @translator,
                 @seriesKey, @volumeNo, @order, 'manual', 'active', '手动成册', @now, @now)`,
            )
            .run({ root: img.root_id, dir, kind: body.kind, order, now, ...p }).lastInsertRowid,
        );
        u.inserted('collections', collectionId);
      }
      u.columns('images', ['collection_id', 'page_no'], members.map((m) => m.page.id));
      const n = this.service.assignPages(collectionId).length;
      return { message: `已把「${leafOf(dir)}」做成${KIND_LABEL[body.kind]}（${n} 页）` };
    });
    return { ...result, collection: this.loadAll().get(collectionId)!.summary };
  }

  update(idStr: ID, body: UpdateCollectionBody): MutationResult {
    const c = this.requireActive(idStr);
    const db = this.ctx.db;
    const now = iso(this.ctx.clock());
    const leaf = leafOf(c.rel_dir);
    const set: Record<string, unknown> = {};
    const notes: string[] = [];
    let reorder = false;

    if (body.title !== undefined) {
      if (body.title === null) {
        Object.assign(set, { title: parseFolderName(leaf).title, title_manual: 0 });
        notes.push('已恢复自动名');
      } else {
        const t = body.title.trim();
        if (!t) throw new BadRequestError('名字不能为空');
        Object.assign(set, { title: t.normalize('NFC'), title_manual: 1 });
        notes.push(`已改名为《${t}》`);
      }
    }
    if (body.kind !== undefined) {
      if (body.kind === 'auto') {
        const members = this.members(c.root_id, c.rel_dir).map((m) => m.page);
        const f = dirFeatures(members);
        const k = autoKind(leaf, f, members.length ? (decideCollection(leaf, f)?.rule ?? null) : null);
        Object.assign(set, { kind: k.kind, kind_source: k.source, kind_manual: 0 });
        notes.push(`已恢复自动判断（${KIND_LABEL[k.kind]}）`);
      } else {
        if (!isKind(body.kind)) throw new BadRequestError('类型只能是本子或画集');
        Object.assign(set, { kind: body.kind, kind_source: 'manual', kind_manual: 1 });
        notes.push(`已改为${KIND_LABEL[body.kind]}`);
      }
    }
    if (body.coverImageId !== undefined) {
      if (body.coverImageId === null) set.cover_image_id = null;
      else {
        const pid = parseId(body.coverImageId);
        if (pid === null || !db.prepare('SELECT 1 FROM images WHERE id = ? AND collection_id = ?').get(pid, c.id)) {
          throw new BadRequestError('封面必须是这本里的一页');
        }
        set.cover_image_id = pid;
      }
      notes.push(body.coverImageId === null ? '已恢复自动封面' : '已换封面');
    }
    if (body.pageOrder !== undefined) {
      if (body.pageOrder !== 'name' && body.pageOrder !== 'mtime') throw new BadRequestError('页序只能是文件名或修改时间');
      set.page_order = body.pageOrder;
      reorder = true;
      notes.push(body.pageOrder === 'name' ? '已改为按文件名排页' : '已改为按修改时间排页');
    }
    if (body.seriesKey !== undefined || body.volumeNo !== undefined) {
      if (body.seriesKey === null) {
        const p = parseFolderName(leaf);
        Object.assign(set, { series_key: p.seriesKey, volume_no: p.volumeNo, series_manual: 0 });
      } else {
        Object.assign(set, {
          series_key: body.seriesKey !== undefined ? body.seriesKey.trim() || null : c.series_key,
          volume_no: body.volumeNo !== undefined ? body.volumeNo : c.volume_no,
          series_manual: 1,
        });
      }
      notes.push('已更新系列');
    }
    if (body.reviewed !== undefined) {
      set.reviewed_at = body.reviewed ? now : null;
      notes.push(body.reviewed ? '已标为已整理' : '已标为待整理');
    }
    const chars = body.manualCharacterIds?.map((x) => this.requireRow('characters', x, '角色'));
    const works = body.manualWorkIds?.map((x) => this.requireRow('works', x, '作品'));
    if (chars) notes.push('已更新出场角色');
    if (works) notes.push('已更新作品');
    if (!notes.length) throw new BadRequestError('没有要修改的内容');

    return this.ctx.mutate((u) => {
      u.columns('collections', MUTABLE, [c.id]);
      this.write(c.id, { ...set, origin: 'manual', updated_at: now });
      if (chars) this.replaceLinks(u, 'collection_characters', 'character_id', c.id, chars, now);
      if (works) this.replaceLinks(u, 'collection_works', 'work_id', c.id, works, now);
      if (reorder) {
        u.columns('images', ['collection_id', 'page_no'], db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[]);
        this.service.assignPages(c.id);
      }
      return { message: notes.join('，') };
    });
  }

  /** 不成册：留一行 dismissed，自动判定不会再建 */
  dismiss(idStr: ID): MutationResult {
    const c = this.requireActive(idStr);
    const db = this.ctx.db;
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      u.columns('collections', MUTABLE, [c.id]);
      u.columns('images', ['collection_id', 'page_no'], db.prepare('SELECT id FROM images WHERE collection_id = ?').pluck().all(c.id) as number[]);
      this.write(c.id, { state: 'dismissed', origin: 'manual', updated_at: now });
      db.prepare('UPDATE images SET collection_id = NULL, page_no = NULL WHERE collection_id = ?').run(c.id);
      return { message: `已取消成册：${c.title ?? '无题'}` };
    });
  }

  bulk(body: BulkCollectionsBody): MutationResult {
    const rows = [...new Set(body.ids)].map((x) => this.requireActive(x));
    const now = iso(this.ctx.clock());
    const a = body.action;
    const target =
      a.type === 'addCharacter'
        ? { id: this.requireRow('characters', a.characterId, '角色'), table: 'collection_characters', col: 'character_id' }
        : a.type === 'addWork'
          ? { id: this.requireRow('works', a.workId, '作品'), table: 'collection_works', col: 'work_id' }
          : null;
    if (a.type === 'kind' && !isKind(a.value)) throw new BadRequestError('类型只能是本子或画集');
    const ids = rows.map((r) => r.id);
    return this.ctx.mutate((u) => {
      u.columns('collections', MUTABLE, ids);
      for (const r of rows) {
        if (a.type === 'review') this.write(r.id, { reviewed_at: now, origin: 'manual', updated_at: now });
        else if (a.type === 'kind') this.write(r.id, { kind: a.value, kind_source: 'manual', kind_manual: 1, origin: 'manual', updated_at: now });
        else this.write(r.id, { origin: 'manual', updated_at: now });
      }
      if (target) {
        const name = target.table as 'collection_characters' | 'collection_works';
        u.set(name, `${target.col} = ? AND collection_id IN (SELECT value FROM json_each(?))`, [target.id, JSON.stringify(ids)]);
        const ins = this.ctx.db.prepare(`INSERT OR IGNORE INTO ${name} (collection_id, ${target.col}, added_at) VALUES (?, ?, ?)`);
        for (const id of ids) ins.run(id, target.id, now);
      }
      const n = ids.length;
      const label =
        a.type === 'review'
          ? `已把 ${n} 本标为已整理`
          : a.type === 'kind'
            ? `已把 ${n} 本改为${KIND_LABEL[a.value]}`
            : `已把 ${n} 本关联到「${this.nameOf(target!.table === 'collection_characters' ? 'characters' : 'works', target!.id)}」`;
      return { message: label };
    });
  }

  // ---------------------------------------------------------------- 内部

  private members(root: number, dir: string): { page: DirPage }[] {
    const rows = this.ctx.db.prepare(DIR_MEMBERS).all({ root, dir }) as {
      id: number;
      file_name: string;
      width: number;
      height: number;
      modified_at: string;
      content_kind: string;
      content_kind_source: string | null;
      content_kind_manual: number;
      tagged_at: string | null;
    }[];
    return rows.map((r) => ({
      page: {
        id: r.id,
        fileName: r.file_name,
        width: r.width,
        height: r.height,
        modifiedAt: r.modified_at,
        kind: r.content_kind,
        judged: isJudged(r),
      },
    }));
  }

  private requireActive(idStr: ID): CollectionRow {
    const id = parseId(idStr);
    const row = id === null ? undefined : (this.ctx.db.prepare("SELECT * FROM collections WHERE id = ? AND state = 'active'").get(id) as CollectionRow | undefined);
    if (!row) throw new NotFoundError('合集');
    return row;
  }

  private requireRow(table: 'characters' | 'works', idStr: ID, label: string): number {
    const id = parseId(idStr);
    if (id === null || !this.ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new NotFoundError(label);
    return id;
  }

  private nameOf(table: 'characters' | 'works', id: number): string {
    return this.ctx.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).pluck().get(id) as string;
  }

  private write(id: number, set: Record<string, unknown>): void {
    const cols = Object.keys(set);
    this.ctx.db.prepare(`UPDATE collections SET ${cols.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...set, id });
  }

  private replaceLinks(
    u: UndoRecorder,
    table: 'collection_characters' | 'collection_works',
    col: string,
    id: number,
    targets: number[],
    now: string,
  ): void {
    u.set(table, 'collection_id = ?', [id]);
    this.ctx.db.prepare(`DELETE FROM ${table} WHERE collection_id = ?`).run(id);
    const ins = this.ctx.db.prepare(`INSERT OR IGNORE INTO ${table} (collection_id, ${col}, added_at) VALUES (?, ?, ?)`);
    for (const t of new Set(targets)) ins.run(id, t, now);
  }
}
