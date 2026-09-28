/**
 * 合集的重算（T38b）：把 detect.ts 的判定结果落进 collections 表，并给页编 page_no。
 *
 * - refreshAll：全量（启动时、扫描有变化后、识别结束后）。一个同步事务，副本上约 0.1–0.3 秒。
 * - refreshDirs：只重算涉及的目录（改类型、排除 / 恢复、回收站、排除规则、文件夹启停之后，RV-C-9）。
 * - assignPages：只重排一本（T38c 的新建和改页序用）。
 *
 * 约定：
 * - 一个文件夹最多一本（UNIQUE(root_id, rel_dir)）；根目录本身不成册。
 * - 用户动过的合集是 origin='manual'，自动判定不会删它，只刷新没被手动改过的字段；
 *   state='dismissed' 的行表示「不成册」，自动判定不会再建。
 * - 手动合集的文件夹改名后跟着搬（≥ 80% 的页落在同一个新目录）。
 * - 被排除、进回收站、丢失的页离开合集；其余页按页序重新从 1 编号，不留空号。
 */
import type { Db } from '../../db/connection.ts';
import { autoKind, decideCollection, dirFeatures, DETECTOR_VERSION, evidenceOf, isJudged, orderPages, type DirPage, type PageOrder } from './detect.ts';
import { parseFolderName } from './parseName.ts';

interface Row {
  id: number;
  root_id: number;
  rel_path: string;
  file_name: string;
  width: number;
  height: number;
  modified_at: string;
  content_kind: string;
  content_kind_source: string | null;
  content_kind_manual: number;
  tagged_at: string | null;
  collection_id: number | null;
  page_no: number | null;
}

export interface CollectionRow {
  id: number;
  root_id: number;
  rel_dir: string;
  kind: string;
  kind_source: string;
  kind_manual: number;
  title: string | null;
  title_manual: number;
  event: string | null;
  circle: string | null;
  artist: string | null;
  parody: string | null;
  translator: string | null;
  series_key: string | null;
  volume_no: number | null;
  series_manual: number;
  page_order: PageOrder;
  cover_image_id: number | null;
  origin: 'auto' | 'manual';
  state: 'active' | 'dismissed';
  evidence: string | null;
  detector_version: number;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Group {
  rootId: number;
  dir: string;
  pages: (DirPage & { row: Row })[];
}

/**
 * 写操作之后重算合集（RV-C-8）：在 ctx.mutate 回调里调用（同一事务），并用 undo.onUndo 让撤销之后再算一次。
 * ids = 'all' 走全量（排除规则、文件夹启停这类影响面不定的操作）。
 */
export type CollectionsHook = (undo: { onUndo(fn: () => void): void } | null, ids: number[] | 'all') => void;

export interface RefreshResult {
  active: number;
  created: number;
  removed: number;
  updated: number;
  pagesChanged: number;
  ms: number;
}

/** 条件字面包含 trashed_at IS NULL AND missing = 0（T22 的部分索引） */
const ROW_SQL = `SELECT i.id, i.root_id, i.rel_path, i.file_name, i.width, i.height, i.modified_at, i.content_kind, i.content_kind_source,
    i.content_kind_manual, i.tagged_at, i.collection_id, i.page_no
  FROM images i JOIN library_roots r ON r.id = i.root_id
  WHERE r.enabled = 1 AND r.removed_at IS NULL AND i.trashed_at IS NULL AND i.missing = 0 AND i.excluded_by IS NULL`;

const keyOf = (rootId: number, dir: string) => `${rootId}\u0000${dir}`;
const dirOf = (relPath: string, fileName: string) =>
  relPath.length > fileName.length ? relPath.slice(0, relPath.length - fileName.length - 1) : '';
const leafOf = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1);

/** 自动判定会写的列 */
const AUTO_COLS = [
  'kind',
  'kind_source',
  'title',
  'event',
  'circle',
  'artist',
  'parody',
  'translator',
  'series_key',
  'volume_no',
  'evidence',
  'detector_version',
] as const;
type AutoFields = Pick<CollectionRow, (typeof AUTO_COLS)[number]>;

export class CollectionService {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  refreshAll(): RefreshResult {
    const t0 = performance.now();
    const res = this.db.transaction(() => {
      const groups = this.group(this.db.prepare(ROW_SQL).all() as Row[]);
      const existing = new Map<string, CollectionRow>();
      for (const c of this.db.prepare('SELECT * FROM collections').all() as CollectionRow[]) existing.set(keyOf(c.root_id, c.rel_dir), c);
      this.followRenames(groups, existing);
      return this.apply(groups, existing, null);
    })();
    return { ...res, ms: performance.now() - t0 };
  }

  /** 只重算这些图所在的目录（RV-C-9 (b)） */
  refreshDirs(imageIds: number[]): RefreshResult {
    const t0 = performance.now();
    if (!imageIds.length) return { active: 0, created: 0, removed: 0, updated: 0, pagesChanged: 0, ms: 0 };
    const res = this.db.transaction(() => {
      const dirs = this.db
        .prepare(
          `SELECT DISTINCT root_id AS rootId, substr(rel_path, 1, length(rel_path) - length(file_name) - 1) AS dir
           FROM images WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(imageIds)) as { rootId: number; dir: string }[];
      const scope = new Set(dirs.filter((d) => d.dir).map((d) => keyOf(d.rootId, d.dir)));
      const rows: Row[] = [];
      const stmt = this.db.prepare(
        `${ROW_SQL} AND i.root_id = @rootId AND substr(i.rel_path, 1, length(@prefix)) = @prefix AND instr(substr(i.rel_path, length(@prefix) + 1), '/') = 0`,
      );
      for (const d of dirs) if (d.dir) rows.push(...(stmt.all({ rootId: d.rootId, prefix: `${d.dir}/` }) as Row[]));
      const existing = new Map<string, CollectionRow>();
      const byKey = this.db.prepare('SELECT * FROM collections WHERE root_id = ? AND rel_dir = ?');
      for (const d of dirs) {
        const c = byKey.get(d.rootId, d.dir) as CollectionRow | undefined;
        if (c) existing.set(keyOf(c.root_id, c.rel_dir), c);
      }
      return this.apply(this.group(rows), existing, scope);
    })();
    return { ...res, ms: performance.now() - t0 };
  }

  /** 只重排一本：按它的 page_order 从 1 编号，返回成员 id（按页序） */
  assignPages(collectionId: number): number[] {
    const c = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId) as CollectionRow | undefined;
    if (!c) return [];
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `${ROW_SQL} AND i.root_id = @rootId AND substr(i.rel_path, 1, length(@prefix)) = @prefix AND instr(substr(i.rel_path, length(@prefix) + 1), '/') = 0`,
        )
        .all({ rootId: c.root_id, prefix: `${c.rel_dir}/` }) as Row[];
      const g = this.group(rows).get(keyOf(c.root_id, c.rel_dir));
      const keep = c.state === 'active' && g ? this.number(c.id, g, c.page_order) : { ids: [] as number[], changed: 0 };
      this.db
        .prepare(
          'UPDATE images SET collection_id = NULL, page_no = NULL WHERE collection_id = ? AND id NOT IN (SELECT value FROM json_each(?))',
        )
        .run(c.id, JSON.stringify(keep.ids));
      return keep.ids;
    })();
  }

  // ---------------------------------------------------------------- 内部

  private group(rows: Row[]): Map<string, Group> {
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const dir = dirOf(r.rel_path, r.file_name);
      if (!dir) continue; // 根目录本身不成册
      const key = keyOf(r.root_id, dir);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { rootId: r.root_id, dir, pages: [] }));
      g.pages.push({
        id: r.id,
        fileName: r.file_name,
        width: r.width,
        height: r.height,
        modifiedAt: r.modified_at,
        kind: r.content_kind,
        judged: isJudged(r),
        row: r,
      });
    }
    return groups;
  }

  /** (4) 手动合集的文件夹改名后跟着搬：它原来的目录没有页了，≥ 80% 的页落在同一个新目录 */
  private followRenames(groups: Map<string, Group>, existing: Map<string, CollectionRow>): void {
    const upd = this.db.prepare('UPDATE collections SET rel_dir = ?, updated_at = ? WHERE id = ?');
    for (const [key, c] of [...existing]) {
      if (c.origin !== 'manual' || c.state !== 'active' || groups.has(key)) continue;
      const rows = this.db
        .prepare('SELECT rel_path, file_name, root_id FROM images WHERE collection_id = ? AND trashed_at IS NULL AND missing = 0')
        .all(c.id) as { rel_path: string; file_name: string; root_id: number }[];
      if (!rows.length) continue;
      const count = new Map<string, number>();
      for (const r of rows) {
        const d = dirOf(r.rel_path, r.file_name);
        if (r.root_id === c.root_id && d) count.set(d, (count.get(d) ?? 0) + 1);
      }
      const [best, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      const newKey = keyOf(c.root_id, best);
      if (!best || n / rows.length < 0.8 || existing.has(newKey)) continue;
      upd.run(best, this.now(), c.id);
      existing.delete(key);
      existing.set(newKey, { ...c, rel_dir: best });
    }
  }

  /**
   * (5) 逐组决定 + (5b) 清掉孤行 + (6) 编页码。scope 为 null 时是全量；否则只处理 scope 里的目录。
   */
  private apply(groups: Map<string, Group>, existing: Map<string, CollectionRow>, scope: Set<string> | null): Omit<RefreshResult, 'ms'> {
    const now = this.now();
    const db = this.db;
    let created = 0;
    let removed = 0;
    let updated = 0;
    const del = db.prepare('DELETE FROM collections WHERE id = ?');
    const ins = db.prepare(`INSERT INTO collections (root_id, rel_dir, kind, kind_source, title, event, circle, artist, parody, translator,
        series_key, volume_no, page_order, origin, state, evidence, detector_version, created_at, updated_at)
      VALUES (@root_id, @rel_dir, @kind, @kind_source, @title, @event, @circle, @artist, @parody, @translator,
        @series_key, @volume_no, @page_order, 'auto', 'active', @evidence, @detector_version, @now, @now)`);
    const active = new Map<number, { c: CollectionRow; g: Group }>();

    for (const [key, g] of groups) {
      if (scope && !scope.has(key)) continue;
      const ex = existing.get(key);
      if (ex?.state === 'dismissed') continue;
      const leaf = leafOf(g.dir);
      const f = dirFeatures(g.pages);
      const parsed = parseFolderName(leaf);
      if (ex?.origin === 'manual') {
        const decided = decideCollection(leaf, f);
        const k = autoKind(leaf, f, decided?.rule ?? null);
        const next = this.fieldsFor(ex, k, parsed, evidenceOf(decided?.rule ?? null, f, k, leaf));
        if (this.update(ex, next, now)) updated++;
        active.set(ex.id, { c: ex, g });
        continue;
      }
      const d = decideCollection(leaf, f);
      if (!d) {
        if (ex) {
          del.run(ex.id);
          removed++;
        }
        continue;
      }
      const k = autoKind(leaf, f, d.rule);
      const evidence = evidenceOf(d.rule, f, k, leaf);
      if (ex) {
        if (this.update(ex, this.fieldsFor(ex, k, parsed, evidence), now)) updated++;
        active.set(ex.id, { c: ex, g });
      } else {
        const fields = this.fieldsFor(null, k, parsed, evidence);
        const id = Number(ins.run({ ...fields, root_id: g.rootId, rel_dir: g.dir, page_order: d.pageOrder, now }).lastInsertRowid);
        created++;
        const c = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow;
        existing.set(key, c);
        active.set(id, { c, g });
      }
    }

    // (5b) 自动合集的目录已经没有可见页（改名、整本进回收站、目录删除）→ 删除（RV-C-14）
    for (const [key, ex] of existing) {
      if (ex.origin !== 'auto' || groups.has(key) || (scope && !scope.has(key))) continue;
      del.run(ex.id);
      existing.delete(key);
      removed++;
    }

    // (6) 页码
    const keep: number[] = [];
    let pagesChanged = 0;
    for (const { c, g } of active.values()) {
      const r = this.number(c.id, g, c.page_order);
      keep.push(...r.ids);
      pagesChanged += r.changed;
    }
    const keepJson = JSON.stringify(keep);
    const clear = scope
      ? db
          .prepare(
            `UPDATE images SET collection_id = NULL, page_no = NULL
             WHERE collection_id IN (SELECT value FROM json_each(@colls)) AND id NOT IN (SELECT value FROM json_each(@keep))`,
          )
          .run({
            colls: JSON.stringify([...existing.entries()].filter(([k]) => scope.has(k)).map(([, c]) => c.id)),
            keep: keepJson,
          })
      : db
          .prepare(
            'UPDATE images SET collection_id = NULL, page_no = NULL WHERE collection_id IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))',
          )
          .run(keepJson);
    pagesChanged += clear.changes;
    const total = db.prepare("SELECT COUNT(*) FROM collections WHERE state = 'active'").pluck().get() as number;
    return { active: total, created, removed, updated, pagesChanged };
  }

  /** 按页序从 1 编号，只写真的变了的行 */
  private number(collectionId: number, g: Group, order: PageOrder): { ids: number[]; changed: number } {
    const upd = this.db.prepare('UPDATE images SET collection_id = ?, page_no = ? WHERE id = ?');
    let changed = 0;
    const ordered = orderPages(g.pages, order);
    ordered.forEach((p, i) => {
      if (p.row.collection_id !== collectionId || p.row.page_no !== i + 1) {
        upd.run(collectionId, i + 1, p.id);
        changed++;
      }
    });
    return { ids: ordered.map((p) => p.id), changed };
  }

  /** 自动判定给出的字段；手动改过的类型、标题、系列保留原值 */
  private fieldsFor(
    ex: CollectionRow | null,
    k: { kind: string; source: 'pages' | 'name' },
    p: ReturnType<typeof parseFolderName>,
    evidence: string,
  ): AutoFields {
    return {
      kind: ex?.kind_manual ? ex.kind : k.kind,
      kind_source: ex?.kind_manual ? ex.kind_source : k.source,
      title: ex?.title_manual ? ex.title : p.title,
      event: p.event,
      circle: p.circle,
      artist: p.artist,
      parody: p.parody,
      translator: p.translator,
      series_key: ex?.series_manual ? ex.series_key : p.seriesKey,
      volume_no: ex?.series_manual ? ex.volume_no : p.volumeNo,
      evidence,
      detector_version: DETECTOR_VERSION,
    };
  }

  /** 有字段变了才写（连同 updated_at） */
  private update(ex: CollectionRow, next: AutoFields, now: string): boolean {
    const changed = AUTO_COLS.filter((col) => ex[col] !== next[col]);
    if (!changed.length) return false;
    this.db
      .prepare(`UPDATE collections SET ${changed.map((col) => `${col} = @${col}`).join(', ')}, updated_at = @now WHERE id = @id`)
      .run({ ...Object.fromEntries(changed.map((col) => [col, next[col]])), now, id: ex.id });
    Object.assign(ex, next);
    return true;
  }
}
