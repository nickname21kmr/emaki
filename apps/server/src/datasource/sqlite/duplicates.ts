/**
 * 重复组的查询与处理（T16）。组本身由 services/dedupe/DedupeService 生成。
 * resolve 把没选中的移到回收站（先在库里标记，晚一点才真的移，见 pendingTrash.ts），可撤销。
 * 删之前把副本上手动做的整理（手动角色、收藏、原创、分级、画师、来源）并到保留的图上，免得跟着副本一起没了。
 */
import type { Db } from '../../db/connection.ts';
import type { DuplicateGroup, ID, ListDuplicatesQuery, MutationResult } from '@emaki/shared';
import { BadRequestError, NotFoundError } from '../../http/errors.ts';
import { parseDHash, popcount32 } from '../../services/dedupe/hamming.ts';
import { pickKeep } from '../../services/dedupe/pickKeep.ts';
import { toAbs } from '../../services/fs/paths.ts';
import type { SqliteContext } from './context.ts';
import type { PendingTrash } from './pendingTrash.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
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

/** 分级从松到严，副本上手动改过的分级不一样时取最严的 */
const RATING_ORDER = `CASE d.rating WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2 WHEN 'sensitive' THEN 1 ELSE 0 END`;

/** carryOver 会改到的 images 列（撤销时还原） */
const CARRY_COLS = [
  'favorite',
  'original_at',
  'rating',
  'rating_manual',
  'source_site',
  'source_post_id',
  'source_artist',
  'source_url',
  'source_manual',
  'artist_manual',
  'artist_checked_at',
];

/**
 * 移到回收站之前，把副本上用户手动做的整理并到保留的图上：手动归的角色、收藏、归为原创、手动分级、手动改的画师、手动确认的来源。
 * 保留的图自己已有的不动（已有的角色、改过的分级、画师和来源）。识别器认的不搬，保留的图自己会认。必须在事务内调用
 */
function carryOver(db: Db, keep: number[], gone: number[], now: string): void {
  const p = { k: JSON.stringify(keep), g: JSON.stringify(gone), now };
  const K = 'images.id IN (SELECT value FROM json_each(@k)) AND images.trashed_at IS NULL';
  const G = 'd.id IN (SELECT value FROM json_each(@g))';
  db.prepare(
    `INSERT OR IGNORE INTO image_characters (image_id, character_id, origin, score, added_at)
     SELECT images.id, ic.character_id, 'manual', ic.score, ic.added_at
     FROM images JOIN image_characters ic ON ic.origin = 'manual' AND ic.image_id IN (SELECT value FROM json_each(@g))
     WHERE ${K} ORDER BY ic.added_at`,
  ).run(p);
  db.prepare(`UPDATE images SET favorite = 1 WHERE ${K} AND favorite = 0 AND EXISTS (SELECT 1 FROM images d WHERE ${G} AND d.favorite = 1)`).run(p);
  // 归为原创连「原创」作品的手动关联一起补上（同 bulk）：不然图算原创，原创作品页里却没有它。
  // 要在改 original_at 之前：只补这次才变成原创的；识别器认出的那行（score 不为空）INSERT OR IGNORE 不动
  db.prepare(
    `INSERT OR IGNORE INTO image_copyrights (image_id, work_id, score)
     SELECT images.id, w.id, NULL FROM images JOIN works w ON w.danbooru_tag = 'original'
     WHERE ${K} AND images.original_at IS NULL AND EXISTS (SELECT 1 FROM images d WHERE ${G} AND d.original_at IS NOT NULL)`,
  ).run(p);
  db.prepare(`UPDATE images SET original_at = (SELECT min(d.original_at) FROM images d WHERE ${G}) WHERE ${K} AND original_at IS NULL`).run(p);
  db.prepare(
    `UPDATE images SET rating_manual = 1, rating = (SELECT d.rating FROM images d WHERE ${G} AND d.rating_manual = 1 ORDER BY ${RATING_ORDER} DESC LIMIT 1)
     WHERE ${K} AND rating_manual = 0 AND EXISTS (SELECT 1 FROM images d WHERE ${G} AND d.rating_manual = 1)`,
  ).run(p);
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
  if (src === undefined) return;
  const targets = db.prepare(`SELECT id FROM images WHERE ${K} AND artist_manual = 0`).pluck().all(p) as number[];
  for (const t of targets) {
    db.prepare('DELETE FROM image_artists WHERE image_id = ?').run(t);
    db.prepare('INSERT INTO image_artists (image_id, artist, score) SELECT ?, artist, score FROM image_artists WHERE image_id = ?').run(t, src);
    db.prepare('UPDATE images SET artist_manual = 1, artist_checked_at = COALESCE(artist_checked_at, ?) WHERE id = ?').run(now, t);
  }
}

export class DuplicateQueries {
  constructor(
    private readonly ctx: SqliteContext,
    private readonly pending: PendingTrash,
    /** 移到回收站之后重算合集（T38b） */
    private readonly collections: CollectionsHook = () => {},
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
      const kj = JSON.stringify(kept);
      // carryOver 会改保留的图：先记下来，撤销时还原
      for (const t of ['image_characters', 'image_copyrights', 'image_artists'] as const) u.set(t, 'image_id IN (SELECT value FROM json_each(?))', [kj]);
      u.columns('images', [...CARRY_COLS, 'trashed_at'], [...kept, ...gone]);
      u.columns('duplicate_groups', ['resolved_at'], [g.id]);
      carryOver(db, kept, gone, now);
      db.prepare('UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(gone));
      // 保留的图可能刚并进了角色，它所在的合集也要重算
      this.collections(u, [...gone, ...kept]);
      db.prepare('UPDATE duplicate_groups SET resolved_at = ? WHERE id = ?').run(now, g.id);
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
      return { message: '已标记为「不是重复」' };
    });
  }
}
