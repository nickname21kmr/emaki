/**
 * 重复组的查询与处理（T16）。组本身由 services/dedupe/DedupeService 生成。
 * resolve 把没选中的移到回收站（先在库里标记，晚一点才真的移，见 pendingTrash.ts），可撤销。
 * 删之前把副本上的整理（角色、收藏、原创、分级、放下、画师、来源）并到保留的图上，免得跟着副本一起没了（角色等经归类模块，附录 #12）。
 */
import type { Db } from '../../db/connection.ts';
import type { DuplicateGroup, ID, ListDuplicatesQuery, MutationResult } from '@emaki/shared';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import { parseDHash, popcount32 } from '../../services/dedupe/hamming.ts';
import { pickKeep } from '../../services/dedupe/pickKeep.ts';
import { toAbs } from '../../services/fs/paths.ts';
import type { SqliteContext } from './context.ts';
import type { PendingTrash } from './pendingTrash.ts';
import type { UndoRecorder } from './undo.ts';
import { carryLinks } from '../../domain/curation/links.ts';
import { carryMarks } from '../../domain/curation/marks.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import { iso, parseId, toId } from './sql.ts';

interface GroupRow {
  id: number;
  kind: 'exact' | 'similar';
  similarity: number;
  comparison: 'pixels' | 'visual' | null;
  suggested_keep_id: number | null;
  resolved_at: string | null;
  ignored: number;
}
type MemberRow = ImageRow & { group_id: number; visible: number; root_path: string; collection_id: number | null };

/** 「同一套」：代表图两两距离不超过它（64 位 dHash） */
export const SET_MAX_DISTANCE = 16;
/** 超过这么多张的文件夹（手机备份根目录、QQ 缓存）里「同文件夹」说明不了什么，不归套 */
export const SET_FOLDER_MAX = 500;

/** carryOver 在这里改的 images 列（撤销时还原）；角色、收藏、原创、分级、放下由归类模块改，自己记撤销 */
const CARRY_COLS = ['source_site', 'source_post_id', 'source_artist', 'source_url', 'source_manual', 'artist_manual', 'artist_checked_at'];

/**
 * 移到回收站之前，把副本上的整理并到保留的图上（附录 #12）。保留的图自己已有的不动。必须在事务内调用。
 * - 角色关联、收藏、原创、手动分级、放下：归类模块的命令（carryLinks、carryMarks）。手动的关联搬成手动，
 *   自动的搬成自动（规则 dedupe-merge），保留的图上被否决过的不搬；
 * - 手动确认的来源、手动改的画师：还在这里搬（来源和画师的证据 / 决定还没拆开，P3b）。
 * 返回各类改了的图（声明变化用）
 */
function carryOver(ctx: SqliteContext, u: UndoRecorder, keep: number[], gone: number[], now: string) {
  const db = ctx.db;
  const p = { k: JSON.stringify(keep), g: JSON.stringify(gone), now };
  const K = 'images.id IN (SELECT value FROM json_each(@k)) AND images.trashed_at IS NULL';
  const G = 'd.id IN (SELECT value FROM json_each(@g))';
  const kept = db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL').pluck().all(p.k) as number[];
  carryLinks(ctx, u, kept, gone);
  const originalWork = (db.prepare("SELECT id FROM works WHERE danbooru_tag = 'original'").pluck().get() as number | undefined) ?? null;
  const marks = carryMarks(ctx, u, kept, gone, originalWork);
  // 来源：取第一张手动确认过的副本（有链接的优先于手动清空的）。保留的图自己确认过的不动，自动解析出来的可以被盖掉。
  // 要放在画师前面，画师那段没有手动副本时会提前 return
  const srcId = db
    .prepare(`SELECT d.id FROM images d WHERE ${G} AND d.source_manual = 1 ORDER BY d.source_url IS NULL, d.id LIMIT 1`)
    .pluck()
    .get(p) as number | undefined;
  if (srcId !== undefined)
    db.prepare(
      `UPDATE images SET (source_site, source_post_id, source_artist, source_url, source_manual) =
         (SELECT source_site, source_post_id, source_artist, source_url, 1 FROM images WHERE id = @srcId)
       WHERE ${K} AND source_manual = 0`,
    ).run({ ...p, srcId });
  // 画师：取第一张手动改过的副本，整组照搬
  const src = db.prepare(`SELECT d.id FROM images d WHERE ${G} AND d.artist_manual = 1 ORDER BY d.id LIMIT 1`).pluck().get(p) as number | undefined;
  if (src === undefined) return marks;
  const targets = db.prepare(`SELECT id FROM images WHERE ${K} AND artist_manual = 0`).pluck().all(p) as number[];
  for (const t of targets) {
    db.prepare('DELETE FROM image_artists WHERE image_id = ?').run(t);
    db.prepare('INSERT INTO image_artists (image_id, artist, score) SELECT ?, artist, score FROM image_artists WHERE image_id = ?').run(t, src);
    db.prepare('UPDATE images SET artist_manual = 1, artist_checked_at = COALESCE(artist_checked_at, ?) WHERE id = ?').run(now, t);
  }
  return marks;
}

/** 来源四列拼成一个键：比较合并前后来源有没有变 */
function sourceKeys(db: Db, ids: number[]): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT id, COALESCE(source_site, '') || '|' || COALESCE(source_post_id, '') || '|' || COALESCE(source_artist, '') || '|' || COALESCE(source_url, '') AS k
       FROM images WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { id: number; k: string }[];
  return new Map(rows.map((r) => [r.id, r.k]));
}

export class DuplicateQueries {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly pending: PendingTrash,
  ) {}

  private members(groupIds: number[]): Map<number, MemberRow[]> {
    const rows = this.ctx.db
      .prepare(
        `SELECT m.group_id, ${IMAGE_COLS}, i.collection_id, r.path AS root_path,
                EXISTS (SELECT 1 FROM v_images v WHERE v.id = i.id) AS visible
         FROM duplicate_members m JOIN images i ON i.id = m.image_id JOIN library_roots r ON r.id = i.root_id
         WHERE m.group_id IN (SELECT value FROM json_each(?))
         ORDER BY m.group_id, i.id`,
      )
      .all(JSON.stringify(groupIds)) as MemberRow[];
    const out = new Map<number, MemberRow[]>();
    for (const r of rows) {
      const list = out.get(r.group_id);
      if (list) list.push(r);
      else out.set(r.group_id, [r]);
    }
    return out;
  }

  list(q: ListDuplicatesQuery): DuplicateGroup[] {
    const resolved = q.resolved ?? false;
    const groups = this.ctx
      .stmt(
        `SELECT id, kind, similarity, comparison, suggested_keep_id, resolved_at, ignored FROM duplicate_groups
         WHERE (@resolved = 1 AND resolved_at IS NOT NULL) OR (@resolved = 0 AND resolved_at IS NULL AND ignored = 0)
         -- 未处理的：完全一样的在最前，再按相似度从高到低（越像越该先处理）；已处理的按时间
         ORDER BY CASE WHEN @resolved = 0 THEN (kind = 'exact') END DESC,
                  CASE WHEN @resolved = 0 THEN similarity END DESC,
                  created_at DESC, id DESC`,
      )
      .all({ resolved: resolved ? 1 : 0 }) as GroupRow[];
    const members = this.members(groups.map((g) => g.id));
    const kept: { g: GroupRow; rows: NonNullable<ReturnType<typeof members.get>>; keep: number }[] = [];
    for (const g of groups) {
      // 未处理的组只看可见成员；已处理的保留全部（包括已移到回收站的）
      const rows = (members.get(g.id) ?? []).filter((m) => resolved || m.visible);
      if (rows.length < (resolved ? 1 : 2)) continue;
      kept.push({ g, rows, keep: rows.some((m) => m.id === g.suggested_keep_id) ? g.suggested_keep_id! : pickKeep(rows).id });
    }
    // 所有组的图一次补全（T22：真实库 5000 多组，逐组补全是一万多条查询、1 秒多）
    const items = hydrateImages(
      this.ctx.db,
      kept.flatMap((k) => k.rows),
    );
    let at = 0;
    const sets = resolved
      ? new Map<number, number>()
      : this.findSets(kept.map(({ g, rows, keep }) => ({ id: g.id, rep: rows.find((m) => m.id === keep)! })));
    const out = kept.map(({ g, rows, keep }) => ({
      id: toId(g.id),
      kind: g.kind,
      similarity: g.similarity,
      ...(g.comparison ? { comparison: g.comparison } : {}),
      images: items.slice(at, (at += rows.length)),
      suggestedKeepId: toId(keep),
      // 书里的页默认都留着，只删合集外的副本
      suggestedKeepIds: [...new Set([keep, ...rows.filter((m) => m.collection_id != null).map((m) => m.id)])].map(toId),
      resolved: g.resolved_at !== null,
      setId: sets.has(g.id) ? toId(sets.get(g.id)!) : null,
    }));
    // 同一套的挪到一起，排在这套里最靠前的那组的位置
    const bySet = new Map<string, DuplicateGroup[]>();
    for (const d of out) if (d.setId) bySet.set(d.setId, [...(bySet.get(d.setId) ?? []), d]);
    return out.flatMap((d) => (!d.setId ? [d] : d.id === bySet.get(d.setId)![0]!.id ? bySet.get(d.setId)! : []));
  }

  /**
   * 组 id → 所在「套」的 id（这套里第一组的 id）。只看代表图：同一文件夹（且不超过 SET_FOLDER_MAX 张）、
   * 宽高完全相同、和这套里已有的每一组都不超过 SET_MAX_DISTANCE。要求两两相近而不是连通，免得 A 像 B、B 像 C 把 A、C 连起来
   */
  private findSets(groups: { id: number; rep: MemberRow }[]): Map<number, number> {
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
    const byKey = new Map<string, { id: number; rep: MemberRow }[]>();
    for (const x of groups) {
      const key = `${x.rep.root_id}:${dirOf(x.rep.rel_path)}|${x.rep.width}x${x.rep.height}`;
      byKey.set(key, [...(byKey.get(key) ?? []), x]);
    }
    const candidates = [...byKey.values()].filter((l) => l.length > 1);
    const out = new Map<number, number>();
    if (!candidates.length) return out;
    const hashes = new Map(
      (
        this.ctx.db
          .prepare('SELECT id, dhash FROM images WHERE id IN (SELECT value FROM json_each(?)) AND dhash IS NOT NULL')
          .all(JSON.stringify(candidates.flat().map((x) => x.rep.id))) as { id: number; dhash: string }[]
      ).map((r) => [r.id, parseDHash(r.dhash)] as const),
    );
    const folderCount = this.ctx.db
      .prepare(
        `SELECT count(*) FROM images WHERE root_id = ? AND rel_path >= ? AND rel_path < ? || char(1114111)
         AND instr(substr(rel_path, length(?) + 1), '/') = 0 AND trashed_at IS NULL`,
      )
      .pluck();
    // 同一文件夹里不同尺寸各是一个候选，数量按文件夹缓存（手机备份根目录几万张，别数几十遍）
    const counts = new Map<string, number>();
    const bigFolder = (rootId: number, dir: string) => {
      const k = `${rootId}:${dir}`;
      if (!counts.has(k)) counts.set(k, folderCount.get(rootId, dir, dir, dir) as number);
      return counts.get(k)! > SET_FOLDER_MAX;
    };
    const dist = (a: readonly [number, number], b: readonly [number, number]) =>
      popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
    for (const list of candidates) {
      const dir = dirOf(list[0]!.rep.rel_path);
      if (bigFolder(list[0]!.rep.root_id, dir)) continue;
      const sets: { id: number; h: (readonly [number, number])[] }[] = [];
      for (const x of list) {
        const h = hashes.get(x.rep.id);
        if (!h) continue;
        const s = sets.find((s) => s.h.every((y) => dist(h, y) <= SET_MAX_DISTANCE));
        if (s) {
          s.h.push(h);
          out.set(x.id, s.id);
        } else sets.push({ id: x.id, h: [h] });
      }
      // 只有一组的「套」不算
      for (const s of sets) if (s.h.length > 1) out.set(s.id, s.id);
    }
    return out;
  }

  private group(idStr: ID): GroupRow {
    const id = parseId(idStr);
    const g = id === null ? undefined : (this.ctx.stmt('SELECT * FROM duplicate_groups WHERE id = ?').get(id) as GroupRow | undefined);
    if (!g) throw new NotFoundError('重复组');
    return g;
  }

  /** batch：「全部处理」一次点下去的多组传同一个，在可撤销的窗口里只算一次 */
  async resolve(idStr: ID, keepIdStrs: ID[], batch?: string): Promise<MutationResult> {
    const g = this.group(idStr);
    if (!keepIdStrs.length) throw new BadRequestError('至少保留一张');
    const rows = this.members([g.id]).get(g.id) ?? [];
    const memberIds = new Set(rows.map((m) => m.id));
    const keep = new Set(keepIdStrs.map((s) => parseId(s)));
    for (const k of keep) if (k === null || !memberIds.has(k)) throw new BadRequestError('保留的图不在这个重复组里');
    const now = iso(this.ctx.clock());
    const toTrash = rows.filter((m) => m.visible && !keep.has(m.id));

    if (!toTrash.length) {
      return this.ctx.mutate((u) => {
        u.columns('duplicate_groups', ['resolved_at'], [g.id]);
        this.ctx.db.prepare('UPDATE duplicate_groups SET resolved_at = ? WHERE id = ?').run(now, g.id);
        this.ctx.changed({ type: 'duplicates.changed', ids: [...keep].filter((x): x is number => x !== null) });
        return { message: `已保留 ${keep.size} 张，0 张移到回收站` };
      });
    }

    // 点的时候就检查有没有回收站；文件晚一点才真的移（pendingTrash.ts），这一步可撤销
    for (const root of new Set(toTrash.map((m) => m.root_path))) await this.pending.checkRoot(root);
    const gone = toTrash.map((m) => m.id);
    const kept = rows.filter((m) => keep.has(m.id)).map((m) => m.id);
    let batchId = 0;
    const res = this.ctx.mutate((u) => {
      const db = this.ctx.db;
      // carryOver 在这里改的画师和来源：先记下来，撤销时还原（归类模块改的自己记撤销）
      u.set('image_artists', 'image_id IN (SELECT value FROM json_each(?))', [JSON.stringify(kept)]);
      u.columns('images', CARRY_COLS, kept);
      u.columns('images', ['trashed_at'], gone);
      u.columns('duplicate_groups', ['resolved_at'], [g.id]);
      const sourceBefore = sourceKeys(db, kept);
      // 角色、收藏、原创、分级、放下由归类模块并过去并声明变化（套排除规则、重新登记 Pixiv 等由反应做）
      carryOver(this.ctx, u, kept, gone, now);
      db.prepare('UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(gone));
      // 来源变了：刷新同投稿组、清过期的 Pixiv 建议、重新登记都由反应做（image.sourceChanged）
      const sourceAfter = sourceKeys(db, kept);
      this.ctx.changed({ type: 'image.trashed', ids: gone });
      this.ctx.changed({ type: 'curation.artistsChanged', ids: kept });
      this.ctx.changed({ type: 'image.sourceChanged', ids: kept.filter((id) => sourceAfter.get(id) !== sourceBefore.get(id)) });
      db.prepare('UPDATE duplicate_groups SET resolved_at = ? WHERE id = ?').run(now, g.id);
      this.ctx.changed({ type: 'duplicates.changed', ids: [...kept, ...gone] });
      batchId = this.pending.record(u, toTrash.map((m) => ({ id: m.id, abs: toAbs(m.root_path, m.rel_path) })), batch);
      return { message: `已保留 ${keep.size} 张，${gone.length} 张移到回收站` };
    });
    return this.pending.added(batchId, res);
  }

  ignore(idStr: ID): MutationResult {
    const g = this.group(idStr);
    const now = iso(this.ctx.clock());
    return this.ctx.mutate((u) => {
      u.columns('duplicate_groups', ['ignored', 'resolved_at'], [g.id]);
      this.ctx.db.prepare('UPDATE duplicate_groups SET ignored = 1, resolved_at = ? WHERE id = ?').run(now, g.id);
      this.ctx.changed({ type: 'duplicates.changed', ids: [] });
      return { message: '已标记为「不是重复」' };
    });
  }
}
