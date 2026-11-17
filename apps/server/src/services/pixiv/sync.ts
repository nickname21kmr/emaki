/**
 * Pixiv 补充（证据的提供者，docs/core-architecture.md 第 2.1、4.2 节）：按投稿号取投稿标签（有缓存先用缓存），
 * 用匹配器把标签解释成「候选 + 置信度」和原创信号，整体替换这张图的 Pixiv 证据（domain/evidence/pixiv.ts、store.ts）。
 * 采不采纳、标不标原创、证据不再支持时撤不撤，都由反应 reevaluateAuto 按 decideAuto 决定（P3b，附录 #1、#2，D8）；
 * 这里只在一轮结束时把这轮自动加的关联和原创记成一条「自动改动」（change_log pixiv-sync，设置里能撤回）。
 */
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { iso } from '../../datasource/sqlite/sql.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { DanbooruError } from '../danbooru/client.ts';
import { hasOriginalTag, PixivAccessError, PixivClient, PixivPostError } from './client.ts';
import { createPixivMatcher, type PixivMatcher } from './match.ts';
import type { PixivDiscover } from './discovery.ts';
import { recordChange, type PixivPayload } from '../../datasource/sqlite/changeLog.ts';
import {
  cachedArtwork,
  cacheArtwork,
  clearPendingPixivCache as clearPendingCache,
  completePixivCheck,
  markPixivPostUnavailable,
  PIXIV_ELIGIBLE_BASE,
  PIXIV_PENDING,
  pixivCandidates,
  queuePixivImages as queueImages,
  queueUnseenPixivAnimations as queueAnimations,
} from '../../domain/evidence/pixiv.ts';
import { replaceEvidence } from '../../domain/evidence/store.ts';

const CUSTOM = 'emaki:character:';

/**
 * 请求失败的投稿（断网、超时、5xx、格式异常）：退避期内自动补充不再挑它，免得每次扫描都重新请求同一地址；
 * 用户手动补跑时清掉（resetPixivBackoff，同 tagger/readBackoff）
 */
const RETRY_BACKOFF = 30 * 60_000;
const backoff = new Map<string, number>();
/** 连续失败的投稿数：放在模块里，让出后的续跑、每轮只查一两个的自动补充也能在连续 3 次后停下 */
let consecutiveFailures = 0;
export const resetPixivBackoff = () => {
  backoff.clear();
  consecutiveFailures = 0;
};
const backoffPosts = (): string => {
  const now = Date.now();
  for (const [id, until] of backoff) if (until <= now) backoff.delete(id);
  return JSON.stringify([...backoff.keys()]);
};
const READY = `${PIXIV_PENDING} AND i.source_post_id NOT IN (SELECT value FROM json_each(?))`;

/** 登记待查（证据模块）：ids 给了是自动登记，不给是显式补跑 */
export function queuePixivImages(ctx: SqliteContext, ids?: number[]): void {
  queueImages(ctx.db, ids);
}

/** 以前只查静态图时漏掉的动图补登记 */
export function queueUnseenPixivAnimations(ctx: SqliteContext): void {
  queueAnimations(ctx.db);
}

/** 显式刷新只清这一轮真的会处理的投稿的缓存 */
export function clearPendingPixivCache(ctx: SqliteContext): void {
  clearPendingCache(ctx.db);
}

/** 待补的图片数，不含退避中的投稿（Pipeline 据此决定要不要自动排任务） */
export function pendingPixivCount(ctx: SqliteContext): number {
  return ctx.db.prepare(`SELECT COUNT(*) FROM v_counted_images i WHERE ${READY}`).pluck().get(backoffPosts()) as number;
}

export async function syncPixivCharacters(
  ctx: SqliteContext,
  job: JobContext,
  makeCatalog: () => { catalog: CharacterCatalog; copyrights: CopyrightSource },
  client: Pick<PixivClient, 'artwork'> = new PixivClient(),
  intervalMs = 1000,
  discover?: PixivDiscover,
  options: { imageIds?: number[]; recheckCached?: boolean } = {},
): Promise<string> {
  const { db } = ctx;
  if (options.recheckCached && options.imageIds === undefined) throw new Error('Rechecking cached Pixiv results requires explicit image IDs');
  // 用缓存复算选中的结果（不清旧的检查记录、不联网）：还没认出的、只有候选的，以及 Pixiv 自动标的原创（可以被复算修正，D8）
  const pending = options.recheckCached ? `${PIXIV_ELIGIBLE_BASE}
    AND EXISTS (SELECT 1 FROM pixiv_artwork_cache a WHERE a.post_id=i.source_post_id)
    AND EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id
      AND p.post_id=i.source_post_id AND (
        (i.original_at IS NULL AND (p.checked_at IS NULL OR p.result='unmatched' OR (
          p.result='suggested' AND EXISTS (SELECT 1 FROM v_character_suggestions s WHERE s.image_id=i.id)
        ))) OR (p.result='original' AND i.original_decision='auto' AND i.original_evidence_provider='pixiv' AND p.modified_at=i.modified_at)
      ))` : PIXIV_PENDING;
  const scope=options.imageIds===undefined ? '' : ' AND i.id IN (SELECT value FROM json_each(@imageIds))';
  const scopeParams=options.imageIds===undefined ? {} : {imageIds:JSON.stringify(options.imageIds)};
  const posts = db.prepare(`SELECT DISTINCT i.source_post_id AS id FROM v_counted_images i
    WHERE ${pending} AND i.source_post_id NOT IN (SELECT value FROM json_each(@backoff))${scope}
    ORDER BY i.source_post_id`).all({...scopeParams,backoff:backoffPosts()}) as { id: string }[];
  job.setTotal(posts.length);
  let linked = 0, original = 0, correctedOriginal = 0, suggested = 0, unavailable = 0, unmatched = 0, failed = 0;
  let requested = 0, cached = 0;
  let danbooruDown = '';
  const summary = () => `Pixiv 标签：关联 ${linked} 张 · 原创 ${original} 张${correctedOriginal ? ` · 修正原创 ${correctedOriginal} 张` : ''} · 建议 ${suggested} 张 · 不可访问 ${unavailable} 个投稿 · 未匹配角色 ${unmatched} 个投稿 · 失败 ${failed} 个投稿 · 复用缓存 ${cached} 个投稿 · 联网查询 ${requested} 个投稿${danbooruDown && `（Danbooru 连不上，这轮只用本地词库：${danbooruDown}）`}`;
  if (!posts.length) return summary();
  // 匹配索引全量建一次要一两秒（卡主线程）：第一次用到时才建，之后只增量补
  let match: PixivMatcher | undefined;
  let verificationRevision: number | undefined;
  const matcher = (revision: number): PixivMatcher => {
    if (!match || revision !== verificationRevision) {
      const { catalog, copyrights } = makeCatalog();
      match = createPixivMatcher(db, catalog, copyrights);
      verificationRevision = revision;
    }
    return match;
  };
  const current = db.prepare(`SELECT i.id,i.original_decision FROM v_counted_images i WHERE ${pending} AND i.source_post_id=@postId${scope}`);
  const completePost = (id: string, result: string) => db.transaction(() => {
    const at = iso(ctx.clock());
    for (const row of current.all({...scopeParams,postId:id}) as {id:number}[]) completePixivCheck(db, row.id, at, result);
  })();
  const liveCustom = db.prepare('SELECT 1 FROM characters WHERE id=? AND danbooru_tag IS NULL');
  // 这一轮自动加的（反应 reevaluateAuto 按 Pixiv 证据加的）：这张图上依据 Pixiv、在这一轮开始之后加的
  const roundLinks = db.prepare(`SELECT image_id, character_id, added_at FROM image_characters
    WHERE image_id IN (SELECT value FROM json_each(@ids)) AND decision='auto' AND evidence_provider='pixiv' AND added_at >= @since`);
  const roundOriginals = db.prepare(`SELECT id, original_at FROM images WHERE id IN (SELECT value FROM json_each(@ids))
    AND original_decision='auto' AND original_evidence_provider='pixiv' AND original_at >= @since`);
  const autoOriginal = db.prepare("SELECT 1 FROM images WHERE id=? AND original_decision='auto' AND original_evidence_provider='pixiv'");
  // 这一轮自动加的关联和原创标记：结束（包括让出、出错）时记成一条「自动改动」，设置里能撤回
  const round: Required<PixivPayload> = { links: [], originals: [], correctedOriginals: [] };
  try {
  for (let n = 0; n < posts.length; n++) {
    job.signal.throwIfAborted();
    const post = posts[n]!;
    let artwork = cachedArtwork(db, post.id);
    if (options.recheckCached && !artwork) { job.advance(1, summary()); continue; }
    if (artwork) await yieldToEventLoop(undefined, { signal: job.signal });
    // Cached matching is local and needs no network pacing. Still yield between posts.
    if (!artwork && requested && intervalMs) await sleep(intervalMs, undefined, { signal: job.signal });
    // 同道有更急的任务（扫描、缩略图、查重）：让出。放在间隔之后，续跑时第一个请求离上一个也隔够了；没查的行 checked_at 仍为空
    if (job.shouldYield()) { job.requeue(); return `${summary()}（已让出，稍后继续）`; }
    job.setMessage(`${artwork ? '匹配已缓存的' : '读取'} Pixiv 标签 ${n + 1}/${posts.length} · ${summary()}`);
    try {
      if (!artwork) {
        requested++;
        const fetched = await client.artwork(post.id, job.signal);
        job.signal.throwIfAborted();
        if (fetched) {
          if (fetched.id !== post.id) throw new Error('Pixiv 返回的作品 ID 不匹配');
          cacheArtwork(db, fetched, iso(ctx.clock()));
        }
        artwork = fetched ?? undefined;
      } else cached++;
      if (artwork && discover && !options.recheckCached && !hasOriginalTag(artwork)) {
        try {
          // 写进目录的新角色马上补进索引；后面的请求失败了这部分也不丢
          await discover(artwork, job.signal, (tags) => match?.refresh(tags));
        } catch (error) {
          job.signal.throwIfAborted();
          if (!(error instanceof DanbooruError)) throw error;
          // Danbooru 不通不算 Pixiv 失败：这轮剩下的投稿只用本地词库，和别名补全失败时一样降级
          discover = undefined;
          danbooruDown = error.message;
          console.warn(`[pixiv-tags] Danbooru 在线发现停用：${error.message}`);
        }
      }
      consecutiveFailures = 0;
    } catch (error) {
      job.signal.throwIfAborted();
      failed++;
      console.warn(`[pixiv-tags] ${post.id}: ${String(error)}`);
      if (error instanceof PixivPostError) {
        // Pixiv 明确拒绝这个投稿：记为查过，自动补充不再请求，手动补跑会重试；不算连续失败，免得卡住后面的投稿
        completePost(post.id, 'skipped');
        job.advance(1, summary());
        continue;
      }
      if (error instanceof PixivAccessError) throw new Error(`${summary()}；${error.message}`);
      // 网络、5xx、格式异常不代表检查完成：保留 pending，退避期内自动补充不再挑它
      backoff.set(post.id, Date.now() + RETRY_BACKOFF);
      if (++consecutiveFailures >= 3) {
        consecutiveFailures = 0;
        throw new Error(`${summary()}；${(error as Error).message}`);
      }
      job.advance(1, summary());
      continue;
    }
    job.signal.throwIfAborted();
    if (!artwork) {
      db.transaction(() => {
        completePost(post.id, 'unavailable');
        markPixivPostUnavailable(db, post.id, iso(ctx.clock()));
      })();
      unavailable++; job.advance(1, summary()); continue;
    }
    // 请求期间可能有人手动整理角色；重新读取目录（写证据之前）
    const fresh = makeCatalog();
    let result = matcher(fresh.catalog.verificationRevision)(artwork);
    // 任务期间自建角色可能被合并、删除或编号被新角色占用：伪标签失效就重建索引再匹配（同步执行，写入前不会再变）
    if (result.tags.some((t) => t.startsWith(CUSTOM) && !liveCustom.get(Number(t.slice(CUSTOM.length))))) {
      match = createPixivMatcher(db, fresh.catalog, fresh.copyrights);
      result = match(artwork);
    }
    const isOriginal = !!result.original;
    const noMatch = !result.tags.length && !isOriginal;
    // 这轮 Pixiv 给的结论（证据层面的）：补跑据此决定重不重试
    const outcome = isOriginal ? 'original' : noMatch ? 'unmatched' : result.automatic ? 'linked' : 'suggested';
    const since = iso(ctx.clock());
    const candidates = pixivCandidates(db, result);
    // 整体替换这几张图的 Pixiv 证据；关联、原创由反应 reevaluateAuto 决定（同一个事务）。job:pixiv-tags 弱刷新
    const rows = ctx.apply(() => {
      const rows = current.all({ ...scopeParams, postId: post.id }) as { id: number; original_decision: string | null }[];
      const wasAuto = new Set(rows.filter((r) => autoOriginal.get(r.id)).map((r) => r.id));
      replaceEvidence(ctx, null, 'pixiv', rows.map((r) => ({ imageId: r.id, at: since, original: isOriginal, characters: candidates })));
      for (const r of rows) completePixivCheck(db, r.id, since, outcome);
      return rows.map((r) => ({ ...r, wasAuto: wasAuto.has(r.id) }));
    });
    const ids = JSON.stringify(rows.map((r) => r.id));
    const added = roundLinks.all({ ids, since }) as { image_id: number; character_id: number; added_at: string }[];
    const marked = roundOriginals.all({ ids, since }) as { id: number; original_at: string }[];
    round.links.push(...added.map((l) => [l.image_id, l.character_id, l.added_at] as [number, number, string]));
    round.originals.push(...marked.map((o) => [o.id, 0, o.original_at, 0] as [number, number, string, number]));
    linked += new Set(added.map((l) => l.image_id)).size;
    original += marked.length;
    correctedOriginal += rows.filter((r) => r.wasAuto && !autoOriginal.get(r.id)).length;
    if (!result.automatic && result.tags.length && !isOriginal) suggested += rows.length;
    if (noMatch) unmatched++;
    job.advance(1, summary());
  }
  } finally {
    recordPixivRound(ctx, round);
  }
  return summary();
}

/** 一轮 Pixiv 补充加了关联或原创标记就记一条，什么都没加不记 */
function recordPixivRound(ctx: SqliteContext, round: Required<PixivPayload>): void {
  if (!round.links.length && !round.originals.length && !round.correctedOriginals.length) return;
  const images = new Set([...round.links, ...round.originals, ...round.correctedOriginals].map(row => row[0])).size;
  const chars = [...new Set(round.links.map((l) => l[1]))];
  const names = ctx.db
    .prepare('SELECT name FROM characters WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name LIMIT 3')
    .pluck()
    .all(JSON.stringify(chars)) as string[];
  const linkedImages = new Set(round.links.map((l) => l[0])).size;
  const parts = [
    round.links.length && `给 ${linkedImages} 张图加了角色（${names.join('、')}${chars.length > 3 ? ` 等 ${chars.length} 个` : ''}）`,
    round.originals.length && `${round.originals.length} 张标为原创`,
    round.correctedOriginals.length && `修正 ${round.correctedOriginals.length} 张的原创标记`,
  ].filter(Boolean);
  recordChange(ctx, 'pixiv-sync', `Pixiv 补充：${parts.join('，')}`, round, {
    count: images,
    hint: `撤回这轮 Pixiv 补充的改动（${images} 张图）。`,
  });
}
