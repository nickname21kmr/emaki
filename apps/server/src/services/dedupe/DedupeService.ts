/**
 * 查重：SHA256 文件重复 + dHash 候选 + Pixelmatch 原图复核，再和库里已有的组对账。
 * 分两层：buildGroups 是纯函数（输入行、输出组），reconcile 负责写库。
 */
import type { Db } from '../../db/connection.ts';
import type { JobContext } from '../../core/jobs.ts';
import { findSimilarPairs, parseDHash, popcount32 } from './hamming.ts';
import { pickKeep, type KeepCandidate } from './pickKeep.ts';
import { UnionFind } from './unionFind.ts';
import { setImmediate } from 'node:timers/promises';
import { toAbs } from '../fs/paths.ts';
import { compareImages, COMPARISON_VERSION, type ImageComparison } from './compareImages.ts';
import { ComparisonWorker, ComparisonWorkerError } from './ComparisonWorker.ts';

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
  comparison?: 'pixels' | 'visual';
}

export interface BuildResult {
  groups: BuiltGroup[];
  /** 超过 MAX_COMPONENT 被丢弃的相似簇数 */
  droppedLarge: number;
  /** 没有 dHash 的代表数（还没算感知哈希） */
  missingHash: number;
  representatives: number;
  failedPairs?: number;
}

export const MAX_COMPONENT = 30;
const MAX_ASPECT_LOG = 0.15;

const distance = (a: string, b: string) => {
  const [ah, al] = parseDHash(a);
  const [bh, bl] = parseDHash(b);
  return popcount32((ah ^ bh) >>> 0) + popcount32((al ^ bl) >>> 0);
};

/** 复核结果；diff 只供内部排序，pixels 表示原尺寸解码像素相等 */
export interface PairCheck {
  same(a: DedupeRow, b: DedupeRow): boolean;
  diff(a: DedupeRow, b: DedupeRow): number | null;
  pixels?(a: DedupeRow, b: DedupeRow): boolean;
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
  const membersByRoot = new Map(reps.map((_, k) => [k, [k]]));
  for (const [a, b] of pairs) {
    const ar = uf.find(a), br = uf.find(b);
    if (ar === br) continue;
    const as = membersByRoot.get(ar)!, bs = membersByRoot.get(br)!;
    // Complete-link verification: an unverified or rejected pair must not enter via a chain.
    if (check && !as.every((x) => bs.every((y) => check.same(reps[x]!, reps[y]!)))) continue;
    uf.union(ar, br);
    membersByRoot.delete(ar);
    membersByRoot.delete(br);
    membersByRoot.set(uf.find(ar), [...as, ...bs]);
  }

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
    let pixels = Boolean(check?.pixels);
    if (ks.length > 1) {
      kind = 'similar';
      // 最差一对的像素差异用于内部排序，不作为面向用户的相似百分比
      let max = 0;
      for (let x = 0; x < ks.length; x++)
        for (let y = x + 1; y < ks.length; y++) {
          const a = reps[ks[x]!]!;
          const b = reps[ks[y]!]!;
          max = Math.max(max, check?.diff(a, b) ?? distance(a.dhash!, b.dhash!) / 64);
          pixels &&= Boolean(check?.pixels?.(a, b));
        }
      similarity = 1 - max;
    }
    groups.push({
      kind,
      similarity,
      memberIds: members.map((m) => m.id).sort((a, b) => a - b),
      suggestedKeepId: pickKeep(members).id,
      ...(kind === 'similar' && check ? { comparison: pixels ? 'pixels' as const : 'visual' as const } : {}),
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

  const upd = db.prepare('UPDATE duplicate_groups SET kind = ?, similarity = ?, suggested_keep_id = ?, comparison = ? WHERE id = ?');
  const insGroup = db.prepare(
    'INSERT INTO duplicate_groups (kind, similarity, suggested_keep_id, resolved_at, ignored, created_at, comparison) VALUES (?, ?, ?, NULL, 0, ?, ?)',
  );
  const insMember = db.prepare('INSERT INTO duplicate_members (group_id, image_id) VALUES (?, ?)');
  const matched = new Set<number>();
  const out: ReconcileResult = { inserted: 0, updated: 0, deleted: 0 };

  for (const g of groups) {
    const old = byKey.get(keyOf(g.memberIds));
    if (old) {
      matched.add(old.id);
      if (old.resolved_at === null && !old.ignored) {
        upd.run(g.kind, g.similarity, g.suggestedKeepId, g.comparison ?? null, old.id);
        out.updated++;
      }
      continue;
    }
    if (ignoredSets.some((s) => g.memberIds.every((id) => s.has(id)))) continue;
    const gid = Number(insGroup.run(g.kind, g.similarity, g.suggestedKeepId, now, g.comparison ?? null).lastInsertRowid);
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
      .prepare('SELECT i.id, i.sha256, i.dhash, i.width, i.height, i.bytes, i.added_at, i.file_name, i.collection_id FROM v_counted_images i')
      .all() as DedupeRow[];
  }

  /** Fine verification is shared by jobs and the standalone runner; failures never fall back to dHash. */
  private async build(ctx?: JobContext, compare = compareImages): Promise<BuildResult | null> {
    const cand = findCandidates(this.loadRows(), this.d.getThreshold());
    ctx?.setTotal(cand.pairs.length);
    const sources = this.d.db.prepare(
      'SELECT i.id, i.rel_path, i.frame_count, r.path AS root_path FROM v_counted_images i JOIN library_roots r ON r.id = i.root_id',
    ).all() as { id: number; rel_path: string; frame_count: number | null; root_path: string }[];
    const files = new Map(sources.map((r) => [r.id, toAbs(r.root_path, r.rel_path)]));
    const animated = new Set(sources.filter((r) => (r.frame_count ?? 1) > 1).map((r) => r.id));
    const pairKey = (a: DedupeRow, b: DedupeRow) => [a.sha256, b.sha256].sort().join(':');
    const decisions = new Map<string, ImageComparison>();
    const get = this.d.db.prepare('SELECT result FROM duplicate_comparisons WHERE sha_a = ? AND sha_b = ? AND version = ?');
    const put = this.d.db.prepare('INSERT OR REPLACE INTO duplicate_comparisons (sha_a, sha_b, version, result) VALUES (?, ?, ?, ?)');
    let failedPairs = 0;
    for (let i = 0; i < cand.pairs.length; i++) {
      if (ctx?.signal.aborted || ctx?.shouldYield()) return null;
      const [ai, bi] = cand.pairs[i]!;
      const a = cand.reps[ai]!, b = cand.reps[bi]!;
      if (animated.has(a.id) || animated.has(b.id)) {
        ctx?.advance(1);
        continue;
      }
      const [sa, sb] = [a.sha256, b.sha256].sort() as [string, string];
      const cached = get.get(sa, sb, COMPARISON_VERSION) as { result: string } | undefined;
      if (cached) decisions.set(pairKey(a, b), JSON.parse(cached.result) as ImageComparison);
      else {
        try {
          const result = await compare(files.get(a.id)!, files.get(b.id)!);
          decisions.set(pairKey(a, b), result);
          put.run(sa, sb, COMPARISON_VERSION, JSON.stringify(result));
        } catch (error) {
          if (error instanceof ComparisonWorkerError) throw error;
          // Keep unreadable pairs out of deletion suggestions; retry them on the next run.
          failedPairs++;
        }
      }
      ctx?.advance(1, `查找重复：核对图片 ${i + 1} / ${cand.pairs.length}`);
      if (i % 16 === 0) await setImmediate();
    }
    const result = (a: DedupeRow, b: DedupeRow) => decisions.get(pairKey(a, b));
    const build = groupCandidates(cand, {
      same: (a, b) => Boolean(result(a, b)?.match),
      diff: (a, b) => result(a, b)?.differentFraction ?? 1,
      pixels: (a, b) => result(a, b)?.match === 'pixels',
    });
    return { ...build, failedPairs };
  }

  private finish(build: BuildResult) {
    const at = new Date(this.d.clock()).toISOString();
    const r = this.d.db.transaction(() => reconcile(this.d.db, build.groups, at))();
    this.d.onFinished?.(at);
    this.d.onChanged?.();
    return { build, reconcile: r, message: summarize(build) };
  }

  /** Standalone scripts/tests use the same verifier and persistent pair cache. */
  async runOnce(): Promise<{ build: BuildResult; reconcile: ReconcileResult; message: string }> {
    return this.finish((await this.build())!);
  }

  async run(ctx: JobContext): Promise<string> {
    if (ctx.signal.aborted) return '查找重复：已取消';
    if (ctx.shouldYield()) {
      ctx.requeue();
      return '查找重复：已让出给扫描';
    }
    const worker = new ComparisonWorker();
    const abort = () => { void worker.close(); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      const build = await this.build(ctx, worker.compare);
      if (ctx.signal.aborted) return '查找重复：已取消';
      if (!build) {
        ctx.requeue();
        return '查找重复：已让出给扫描';
      }
      return this.finish(build).message;
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      await worker.close();
    }
  }
}

export function summarize(b: BuildResult): string {
  const exact = b.groups.filter((g) => g.kind === 'exact').length;
  const parts = [`查找重复：${b.groups.length} 组（完全重复 ${exact}，相似 ${b.groups.length - exact}）`];
  if (b.failedPairs) parts.push(`${b.failedPairs} 对图片读取失败，稍后可重试`);
  if (b.missingHash) parts.push(`${b.missingHash} 张还没有感知哈希`);
  if (b.droppedLarge) parts.push(`${b.droppedLarge} 个过大的相似簇已忽略`);
  return parts.join(' · ');
}
