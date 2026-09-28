/**
 * 查重（T16）：sha256 完全重复 + dHash 相似（MIH 近邻 + 并查集），再和库里已有的组对账。
 * 分两层：buildGroups 是纯函数（输入行、输出组），reconcile 负责写库。
 */
import type { Db } from '../../db/connection.ts';
import type { JobContext } from '../../core/jobs.ts';
import { findSimilarPairs, parseDHash, popcount32 } from './hamming.ts';
import { pickKeep, type KeepCandidate } from './pickKeep.ts';
import { UnionFind } from './unionFind.ts';

export interface DedupeRow extends KeepCandidate {
  sha256: string;
  dhash: string | null;
}

export interface BuiltGroup {
  kind: 'exact' | 'similar';
  similarity: number;
  /** 升序 */
  memberIds: number[];
  suggestedKeepId: number;
}

export interface BuildResult {
  groups: BuiltGroup[];
  /** 超过 MAX_COMPONENT 被丢弃的相似簇数 */
  droppedLarge: number;
  /** 没有 dHash 的代表数（还没算感知哈希） */
  missingHash: number;
  representatives: number;
}

export const MAX_COMPONENT = 30;
const MAX_ASPECT_LOG = 0.15;

const distance = (a: string, b: string) => {
  const [ah, al] = parseDHash(a);
  const [bh, bl] = parseDHash(b);
  return popcount32((ah ^ bh) >>> 0) + popcount32((al ^ bl) >>> 0);
};

export function buildGroups(rows: DedupeRow[], threshold: number, onProgress?: (done: number) => void): BuildResult {
  const T = Math.min(Math.max(Math.floor(threshold), 0), 16);
  // 1. 按 sha 分桶，每桶一个代表（优先有 dhash 的）
  const bySha = new Map<string, DedupeRow[]>();
  for (const r of rows) {
    const list = bySha.get(r.sha256);
    if (list) list.push(r);
    else bySha.set(r.sha256, [r]);
  }
  const buckets = [...bySha.values()];
  const reps = buckets.map((b) => b.find((r) => r.dhash) ?? b[0]!);

  // 2. 相似搜索：只放有信息量的哈希
  let missingHash = 0;
  const idx: number[] = [];
  for (let k = 0; k < reps.length; k++) {
    const h = reps[k]!.dhash;
    if (!h) {
      missingHash++;
      continue;
    }
    const [hi, lo] = parseDHash(h);
    const bits = popcount32(hi) + popcount32(lo);
    if (bits <= 4 || bits >= 60) continue;
    idx.push(k);
  }
  const hi = new Uint32Array(idx.length);
  const lo = new Uint32Array(idx.length);
  idx.forEach((k, n) => {
    [hi[n], lo[n]] = parseDHash(reps[k]!.dhash!);
  });
  const uf = new UnionFind(reps.length);
  const aspect = (r: DedupeRow) => r.width / Math.max(r.height, 1);
  findSimilarPairs(hi, lo, T, (a, b) => {
    const ra = reps[idx[a]!]!;
    const rb = reps[idx[b]!]!;
    if (Math.abs(Math.log(aspect(ra) / aspect(rb))) > MAX_ASPECT_LOG) return;
    uf.union(idx[a]!, idx[b]!);
  });
  onProgress?.(reps.length);

  // 3. 连通分量 → 展开成桶里的所有图
  const comps = new Map<number, number[]>();
  for (let k = 0; k < reps.length; k++) {
    const root = uf.find(k);
    const list = comps.get(root);
    if (list) list.push(k);
    else comps.set(root, [k]);
  }
  const groups: BuiltGroup[] = [];
  let droppedLarge = 0;
  for (const ks of comps.values()) {
    const members = ks.flatMap((k) => buckets[k]!);
    if (members.length < 2) continue;
    // 相似簇太大多半是截图、纯色图串成的链；完全相同的文件（ks 只有一个桶）再多也照样上报
    if (ks.length > 1 && members.length > MAX_COMPONENT) {
      droppedLarge++;
      continue;
    }
    let similarity = 1;
    let kind: BuiltGroup['kind'] = 'exact';
    if (ks.length > 1) {
      kind = 'similar';
      let max = 0;
      for (let x = 0; x < ks.length; x++)
        for (let y = x + 1; y < ks.length; y++) max = Math.max(max, distance(reps[ks[x]!]!.dhash!, reps[ks[y]!]!.dhash!));
      similarity = 1 - max / 64;
    }
    groups.push({
      kind,
      similarity,
      memberIds: members.map((m) => m.id).sort((a, b) => a - b),
      suggestedKeepId: pickKeep(members).id,
    });
  }
  return { groups, droppedLarge, missingHash, representatives: reps.length };
}

export interface ReconcileResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** 在一个事务里和已有组对账（调用方负责开事务） */
export function reconcile(db: Db, groups: BuiltGroup[], now: string): ReconcileResult {
  const existing = db
    .prepare(
      `SELECT g.id, g.resolved_at, g.ignored, group_concat(m.image_id) AS members
       FROM duplicate_groups g JOIN duplicate_members m ON m.group_id = g.id GROUP BY g.id`,
    )
    .all() as { id: number; resolved_at: string | null; ignored: number; members: string }[];
  const keyOf = (ids: number[]) => ids.join(',');
  const byKey = new Map<string, (typeof existing)[number]>();
  const ignoredSets: Set<number>[] = [];
  for (const g of existing) {
    const ids = g.members
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    byKey.set(keyOf(ids), g);
    if (g.ignored) ignoredSets.push(new Set(ids));
  }

  const upd = db.prepare('UPDATE duplicate_groups SET kind = ?, similarity = ?, suggested_keep_id = ? WHERE id = ?');
  const insGroup = db.prepare(
    'INSERT INTO duplicate_groups (kind, similarity, suggested_keep_id, resolved_at, ignored, created_at) VALUES (?, ?, ?, NULL, 0, ?)',
  );
  const insMember = db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?)');
  const matched = new Set<number>();
  const out: ReconcileResult = { inserted: 0, updated: 0, deleted: 0 };

  for (const g of groups) {
    const old = byKey.get(keyOf(g.memberIds));
    if (old) {
      matched.add(old.id);
      if (old.resolved_at === null && !old.ignored) {
        upd.run(g.kind, g.similarity, g.suggestedKeepId, old.id);
        out.updated++;
      }
      continue;
    }
    if (ignoredSets.some((s) => g.memberIds.every((id) => s.has(id)))) continue;
    const gid = Number(insGroup.run(g.kind, g.similarity, g.suggestedKeepId, now).lastInsertRowid);
    for (const id of g.memberIds) insMember.run(gid, id);
    out.inserted++;
  }

  const del = db.prepare('DELETE FROM duplicate_groups WHERE id = ?');
  for (const g of existing) {
    if (matched.has(g.id) || g.resolved_at !== null || g.ignored) continue;
    del.run(g.id);
    out.deleted++;
  }
  return out;
}

export interface DedupeServiceDeps {
  db: Db;
  clock: () => number;
  getThreshold: () => number;
  /** 写库后让缓存失效（stats 的 duplicateGroupCount） */
  onChanged?: () => void;
  /** 成功跑完（没被取消）：记下时间，写进 settings.dedupe.lastRunAt */
  onFinished?: (atIso: string) => void;
}

export class DedupeService {
  constructor(private readonly d: DedupeServiceDeps) {}

  loadRows(): DedupeRow[] {
    return this.d.db
      .prepare('SELECT i.id, i.sha256, i.dhash, i.width, i.height, i.bytes, i.added_at, i.file_name FROM v_counted_images i')
      .all() as DedupeRow[];
  }

  /** 不依赖任务队列的版本（脚本和测试用） */
  runOnce(): { build: BuildResult; reconcile: ReconcileResult; message: string } {
    const build = buildGroups(this.loadRows(), this.d.getThreshold());
    const at = new Date(this.d.clock()).toISOString();
    const r = this.d.db.transaction(() => reconcile(this.d.db, build.groups, at))();
    this.d.onFinished?.(at);
    this.d.onChanged?.();
    return { build, reconcile: r, message: summarize(build) };
  }

  async run(ctx: JobContext): Promise<string> {
    if (ctx.shouldYield()) {
      ctx.requeue();
      return '查找重复：已让出给扫描';
    }
    const rows = this.loadRows();
    ctx.setTotal(rows.length);
    const build = buildGroups(rows, this.d.getThreshold(), () => ctx.advance(rows.length));
    if (ctx.signal.aborted) return '查找重复：已取消';
    const at = new Date(this.d.clock()).toISOString();
    this.d.db.transaction(() => reconcile(this.d.db, build.groups, at))();
    this.d.onFinished?.(at);
    this.d.onChanged?.();
    return summarize(build);
  }
}

export function summarize(b: BuildResult): string {
  const exact = b.groups.filter((g) => g.kind === 'exact').length;
  const parts = [`查找重复：${b.groups.length} 组（完全重复 ${exact}，相似 ${b.groups.length - exact}）`];
  if (b.missingHash) parts.push(`${b.missingHash} 张还没有感知哈希`);
  if (b.droppedLarge) parts.push(`${b.droppedLarge} 个过大的相似簇已忽略`);
  return parts.join(' · ');
}
