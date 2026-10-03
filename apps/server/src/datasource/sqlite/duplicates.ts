/**
 * 重复组的查询与处理（T16）。组本身由 services/dedupe/DedupeService 生成。
 * resolve 把没选中的移到系统回收站（逐个核实），不可撤销；一张都没删（全部保留）时可撤销。
 */
import type { DuplicateGroup, ID, ListDuplicatesQuery, MutationResult } from '@emaki/shared';
import { BadRequestError, ConflictError, NotFoundError } from '../../http/errors.ts';
import { parseDHash, popcount32 } from '../../services/dedupe/hamming.ts';
import { pickKeep } from '../../services/dedupe/pickKeep.ts';
import { toAbs } from '../../services/fs/paths.ts';
import { assertRecyclable } from '../../services/trash/driveType.ts';
import { moveToRecycleBin, type TrashImpl } from '../../services/trash/recycleBin.ts';
import type { SqliteContext } from './context.ts';
import { hydrateImages, IMAGE_COLS, type ImageRow } from './hydrate.ts';
import type { CollectionsHook } from '../../services/collections/CollectionService.ts';
import { iso, parseId, toId } from './sql.ts';

interface GroupRow {
  id: number;
  kind: 'exact' | 'similar';
  similarity: number;
  suggested_keep_id: number | null;
  resolved_at: string | null;
  ignored: number;
}
type MemberRow = ImageRow & { group_id: number; visible: number; root_path: string; collection_id: number | null };

/** 「同一套」：代表图两两距离不超过它（64 位 dHash） */
export const SET_MAX_DISTANCE = 16;
/** 超过这么多张的文件夹（手机备份根目录、QQ 缓存）里「同文件夹」说明不了什么，不归套 */
export const SET_FOLDER_MAX = 500;

export class DuplicateQueries {
  constructor(
    private readonly ctx: SqliteContext,
    /** 测试里替换成假的回收站 */
    private readonly trashImpl?: TrashImpl,
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
        `SELECT id, kind, similarity, suggested_keep_id, resolved_at, ignored FROM duplicate_groups
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

  async resolve(idStr: ID, keepIdStrs: ID[]): Promise<MutationResult> {
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

    for (const root of new Set(toTrash.map((m) => m.root_path))) await assertRecyclable(root);
    const byPath = new Map(toTrash.map((m) => [toAbs(m.root_path, m.rel_path), m.id]));
    const res = await moveToRecycleBin([...byPath.keys()], this.trashImpl);
    const done = [...res.trashed, ...res.alreadyGone].map((p) => byPath.get(p)!);
    if (!done.length) throw new ConflictError(`没有文件被移到回收站：${res.failed[0]?.reason ?? '未知原因'}`);
    return this.ctx.write(() => {
      const db = this.ctx.db;
      db.prepare('UPDATE images SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(done));
      this.collections(null, done);
      if (!res.failed.length) db.prepare('UPDATE duplicate_groups SET resolved_at = ? WHERE id = ?').run(now, g.id);
      const tail = res.failed.length ? `，${res.failed.length} 张失败（文件可能被占用）` : '';
      return `已保留 ${keep.size} 张，${done.length} 张移到回收站（可在系统回收站还原）${tail}`;
    });
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
