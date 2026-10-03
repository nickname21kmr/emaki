/**
 * 查重（T16）：sha256 完全重复 + dHash 相似（MIH 近邻 + 并查集），再和库里已有的组对账。
 * 分两层：buildGroups 是纯函数（输入行、输出组），reconcile 负责写库。
 */
import type { Db } from '../../db/connection.ts';
import type { JobContext } from '../../core/jobs.ts';
import { findSimilarPairs, parseDHash, popcount32 } from './hamming.ts';
import { pickKeep, type KeepCandidate } from './pickKeep.ts';
import { UnionFind } from './unionFind.ts';
import { compareFingerprints, computeFingerprint, FINE_BITS, looksSame, type Fingerprint } from './fingerprint.ts';

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

/** 复核：候选对是不是真的像；diff 给相似度用（0 = 一样，1 = 完全不同），没有细指纹时返回 null 用粗哈希 */
export interface PairCheck {
  same(a: DedupeRow, b: DedupeRow): boolean;
  diff(a: DedupeRow, b: DedupeRow): number | null;
}

export interface Candidates {
  buckets: DedupeRow[][];
  reps: DedupeRow[];
  /** reps 的下标对 */
  pairs: [number, number][];
  missingHash: number;
}

export function buildGroups(rows: DedupeRow[], threshold: number, onProgress?: (done: number) => void, check?: PairCheck): BuildResult {
  const c = findCandidates(rows, threshold);
  onProgress?.(c.reps.length);
  return groupCandidates(c, check);
}

/** 1–2：按 sha 分桶，再用 64 位 dHash 找候选对（宽高比差太多的不算） */
export function findCandidates(rows: DedupeRow[], threshold: number): Candidates {
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
  const pairs: [number, number][] = [];
  const aspect = (r: DedupeRow) => r.width / Math.max(r.height, 1);
  findSimilarPairs(hi, lo, T, (a, b) => {
    const ra = reps[idx[a]!]!;
    const rb = reps[idx[b]!]!;
    if (Math.abs(Math.log(aspect(ra) / aspect(rb))) > MAX_ASPECT_LOG) return;
    pairs.push([idx[a]!, idx[b]!]);
  });
  return { buckets, reps, pairs, missingHash };
}

/** 3–4：复核候选对 → 并查集连成组 → 展开成桶里的所有图 */
export function groupCandidates({ buckets, reps, pairs, missingHash }: Candidates, check?: PairCheck): BuildResult {
  const uf = new UnionFind(reps.length);
  for (const [a, b] of pairs) if (!check || check.same(reps[a]!, reps[b]!)) uf.union(a, b);

  // 连通分量 → 展开成桶里的所有图
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
      // 组里最不像的那一对决定相似度；有细指纹就用细的（256 位，更能区分 88% 和 98%）
      let max = 0;
      for (let x = 0; x < ks.length; x++)
        for (let y = x + 1; y < ks.length; y++) {
          const a = reps[ks[x]!]!;
          const b = reps[ks[y]!]!;
          max = Math.max(max, check?.diff(a, b) ?? distance(a.dhash!, b.dhash!) / 64);
        }
      similarity = 1 - max;
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
  /** 240 宽缩略图的路径（细指纹从它算）；不给就只用粗哈希 */
  thumbFile?: (sha256: string) => string;
  /** 成功跑完（没被取消）：记下时间，写进 settings.dedupe.lastRunAt */
  onFinished?: (atIso: string) => void;
}

export class DedupeService {
  constructor(private readonly d: DedupeServiceDeps) {}

  loadRows(): DedupeRow[] {
    return this.d.db
      .prepare('SELECT i.id, i.sha256, i.dhash, i.width, i.height, i.bytes, i.added_at, i.file_name, i.collection_id FROM v_counted_images i')
      .all() as DedupeRow[];
  }

  /**
   * 候选对涉及的图的细指纹：先从 image_fingerprints 读，没有的从 240 缩略图算出来存进去。
   * 第一次要算的可能有上万张（约一两分钟），之后只算新图。有扫描在排队时返回 null 让出。
   * 缩略图还没生成、读失败的不算，复核时当作通过（退回只看粗哈希）。
   */
  private async fingerprints(c: Candidates, ctx: JobContext): Promise<Map<string, Fingerprint> | null> {
    const shas = new Set<string>();
    for (const [a, b] of c.pairs) {
      shas.add(c.reps[a]!.sha256);
      shas.add(c.reps[b]!.sha256);
    }
    const out = new Map<string, Fingerprint>();
    const { db } = this.d;
    const saved = db
      .prepare('SELECT sha256, fine, color FROM image_fingerprints WHERE sha256 IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...shas])) as { sha256: string; fine: Buffer; color: Buffer }[];
    for (const r of saved) out.set(r.sha256, { fine: r.fine, color: r.color });
    const todo = [...shas].filter((s) => !out.has(s));
    if (!todo.length || !this.d.thumbFile) return out;
    const ins = db.prepare('INSERT OR REPLACE INTO image_fingerprints (sha256, fine, color) VALUES (?, ?, ?)');
    for (let i = 0; i < todo.length; i += 16) {
      if (ctx.signal.aborted) return out;
      if (ctx.shouldYield()) return null;
      ctx.setMessage(`查找重复：复核细节 ${i} / ${todo.length}`);
      const got = await Promise.all(
        todo.slice(i, i + 16).map(async (sha) => {
          try {
            return [sha, await computeFingerprint(this.d.thumbFile!(sha))] as const;
          } catch {
            return null;
          }
        }),
      );
      db.transaction(() => {
        for (const g of got) {
          if (!g) continue;
          ins.run(g[0], g[1].fine, g[1].color);
          out.set(g[0], g[1]);
        }
      })();
    }
    return out;
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
    const cand = findCandidates(rows, this.d.getThreshold());
    ctx.advance(rows.length);
    const fps = await this.fingerprints(cand, ctx);
    if (!fps) {
      ctx.requeue(); // 算到一半有扫描在排队：已经算好的存进库了，下次接着算
      return '查找重复：已让出给扫描';
    }
    if (ctx.signal.aborted) return '查找重复：已取消';
    const build = groupCandidates(cand, {
      same: (a, b) => {
        const fa = fps.get(a.sha256);
        const fb = fps.get(b.sha256);
        return !fa || !fb || looksSame(fa, fb);
      },
      diff: (a, b) => {
        const fa = fps.get(a.sha256);
        const fb = fps.get(b.sha256);
        return fa && fb ? compareFingerprints(fa, fb).fd / FINE_BITS : null;
      },
    });
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
