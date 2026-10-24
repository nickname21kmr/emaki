import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { IN_COMIC_I, QUEUE, QUEUE_KINDS_SQL } from '../../datasource/sqlite/sql.ts';
import { applyExclusionRules } from '../../datasource/sqlite/exclusions.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { DanbooruError } from '../danbooru/client.ts';
import { isOriginalArtwork, PixivAccessError, PixivClient, PixivPostError } from './client.ts';
import { createPixivMatcher, type PixivMatcher } from './match.ts';
import type { PixivDiscover } from './discovery.ts';
import { cachedArtwork, cacheArtwork } from './cache.ts';

// Pixiv 也能认出动图的角色：动图不进未识别，但这里一起查。
// 漫画页在设置关掉「未识别里也列出漫画页」时不查（QUEUE_KINDS_SQL）
const ELIGIBLE = `(${QUEUE_KINDS_SQL} OR i.content_kind = 'animated') AND i.shelved_at IS NULL AND i.original_at IS NULL
  AND i.collection_id IS NULL AND NOT ${IN_COMIC_I} AND i.source_site='pixiv' AND i.source_post_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id=i.id)
  AND NOT EXISTS (SELECT 1 FROM character_suggestions cs WHERE cs.image_id=i.id AND cs.source='tagger' AND cs.score>=0.8)
  AND NOT EXISTS (SELECT 1 FROM pixiv_unavailable_posts p WHERE p.post_id=i.source_post_id)`;
const PENDING = `${ELIGIBLE} AND EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id
  AND p.checked_at IS NULL AND p.post_id=i.source_post_id AND p.modified_at=i.modified_at)`;
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
const READY = `${PENDING} AND i.source_post_id NOT IN (SELECT value FROM json_each(?))`;

/**
 * 模型每批写入后登记首次补充；显式补跑还重查未匹配、失败、跳过，以及仍保留建议的图片。
 * 关联/原创被撤掉、明确移除过角色、或建议已被清空的图片不重新写回；换投稿/文件时可重新检查。
 */
export function queuePixivImages(ctx: SqliteContext, ids?: number[]): void {
  const automatic = ids !== undefined;
  ctx.db.prepare(`INSERT INTO pixiv_character_checks(image_id,post_id,modified_at)
    SELECT i.id,i.source_post_id,i.modified_at FROM v_counted_images i WHERE ${ELIGIBLE}
    ${automatic ? 'AND i.id IN (SELECT value FROM json_each(?))' : ''}
    ON CONFLICT(image_id) DO UPDATE SET post_id=excluded.post_id,modified_at=excluded.modified_at,checked_at=NULL,result=NULL
    WHERE pixiv_character_checks.post_id<>excluded.post_id OR pixiv_character_checks.modified_at<>excluded.modified_at
    ${automatic ? '' : `OR COALESCE(pixiv_character_checks.result,'') NOT IN ('linked','original','suggested','dismissed')
      OR (pixiv_character_checks.result='suggested' AND EXISTS
        (SELECT 1 FROM character_suggestions cs WHERE cs.image_id=excluded.image_id))`}`)
    .run(...(automatic ? [JSON.stringify(ids)] : []));
}

/** Backfill only animations missed by the previous static-only eligibility rule. */
export function queueUnseenPixivAnimations(ctx:SqliteContext):void {
  const ids=ctx.db.prepare(`SELECT i.id FROM v_counted_images i WHERE ${ELIGIBLE}
    AND i.content_kind='animated' AND i.tagged_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id)`).pluck().all() as number[];
  if(ids.length) queuePixivImages(ctx,ids);
}

/** Explicit refresh only invalidates posts that this run can actually process. */
export function clearPendingPixivCache(ctx: SqliteContext): void {
  ctx.db.prepare(`DELETE FROM pixiv_artwork_cache WHERE post_id IN
    (SELECT i.source_post_id FROM v_counted_images i WHERE ${PENDING})`).run();
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
  options: { imageIds?: number[] } = {},
): Promise<string> {
  const { db } = ctx;
  const scope=options.imageIds===undefined ? '' : ' AND i.id IN (SELECT value FROM json_each(@imageIds))';
  const scopeParams=options.imageIds===undefined ? {} : {imageIds:JSON.stringify(options.imageIds)};
  const posts = db.prepare(`SELECT DISTINCT i.source_post_id AS id FROM v_counted_images i
    WHERE ${PENDING} AND i.source_post_id NOT IN (SELECT value FROM json_each(@backoff))${scope}
    ORDER BY i.source_post_id`).all({...scopeParams,backoff:backoffPosts()}) as { id: string }[];
  job.setTotal(posts.length);
  let linked = 0, original = 0, suggested = 0, unavailable = 0, unmatched = 0, failed = 0;
  let requested = 0, cached = 0;
  let danbooruDown = '';
  const summary = () => `Pixiv 标签：关联 ${linked} 张 · 原创 ${original} 张 · 建议 ${suggested} 张 · 不可访问 ${unavailable} 个投稿 · 未匹配角色 ${unmatched} 个投稿 · 失败 ${failed} 个投稿 · 复用缓存 ${cached} 个投稿 · 联网查询 ${requested} 个投稿${danbooruDown && `（Danbooru 连不上，这轮只用本地词库：${danbooruDown}）`}`;
  if (!posts.length) return summary();
  // 匹配索引全量建一次要一两秒（卡主线程）：第一次用到时才建，之后只增量补
  let match: PixivMatcher | undefined;
  const matcher = (): PixivMatcher => {
    if (!match) { const u = makeCatalog(); match = createPixivMatcher(db, u.catalog, u.copyrights); }
    return match;
  };
  const current = db.prepare(`SELECT i.id FROM v_counted_images i WHERE ${PENDING} AND i.source_post_id=@postId${scope}`);
  // result：linked / original / suggested / unmatched / unavailable / skipped / dismissed，补跑据此决定重不重试
  const complete = db.prepare(`UPDATE pixiv_character_checks SET checked_at=?,result=? WHERE image_id=?`);
  const completePost = (id: string, result: string) => db.transaction(() => {
    for (const row of current.all({...scopeParams,postId:id}) as {id:number}[]) complete.run(new Date(ctx.clock()).toISOString(),result,row.id);
  })();
  const insert = db.prepare("INSERT OR IGNORE INTO image_characters (image_id,character_id,origin,score,added_at) VALUES (?,?,'tagger',NULL,?)");
  // 自建角色的建议：danbooru_tag 写伪标签占主键，character_id 写真外键（读的时候看 character_id）
  const suggest = db.prepare("INSERT OR IGNORE INTO character_suggestions (image_id,danbooru_tag,character_id,score,source) VALUES (?,?,?,0,'pixiv')");
  const clearPixivSuggestions = db.prepare("DELETE FROM character_suggestions WHERE image_id=? AND source='pixiv'");
  const liveCustom = db.prepare('SELECT 1 FROM characters WHERE id=? AND danbooru_tag IS NULL');
  for (let n = 0; n < posts.length; n++) {
    job.signal.throwIfAborted();
    const post = posts[n]!;
    let artwork = cachedArtwork(db, post.id);
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
          cacheArtwork(db, fetched, new Date(ctx.clock()).toISOString());
        }
        artwork = fetched ?? undefined;
      } else cached++;
      if (artwork && discover && !isOriginalArtwork(artwork)) {
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
        db.prepare('INSERT OR IGNORE INTO pixiv_unavailable_posts(post_id,checked_at) VALUES (?,?)')
          .run(post.id,new Date(ctx.clock()).toISOString());
      })();
      unavailable++; job.advance(1, summary()); continue;
    }
    // 请求期间可能有人手动整理角色；重新读取目录与队列，避免覆盖用户的新决定。
    const fresh = makeCatalog();
    const { catalog } = fresh;
    let result = matcher()(artwork);
    // 任务期间自建角色可能被合并、删除或编号被新角色占用：伪标签失效就重建索引再匹配（同步执行，写入前不会再变）
    if (result.tags.some((t) => t.startsWith(CUSTOM) && !liveCustom.get(Number(t.slice(CUSTOM.length))))) {
      match = createPixivMatcher(db, fresh.catalog, fresh.copyrights);
      result = match(artwork);
    }
    const isOriginal = isOriginalArtwork(artwork);
    const noMatch = !result.tags.length && !isOriginal;
    const outcome = isOriginal ? 'original' : noMatch ? 'unmatched' : result.automatic ? 'linked' : 'suggested';
    const ids: number[] = [];
    db.transaction(() => {
      const rows = current.all({...scopeParams,postId:post.id}) as { id: number }[];
      const now = new Date(ctx.clock()).toISOString();
      for (const row of rows) {
        // 只处理未识别图片，网络请求期间完成的模型/手动关联也不能追加。
        if (db.prepare('SELECT 1 FROM image_characters WHERE image_id=?').get(row.id)) {
          complete.run(now,'skipped',row.id);
          continue;
        }
        let linkChanges = 0, suggestionChanges = 0;
        // 成功取回投稿后才刷新来源建议；失败时保留旧值，同名模型分数也不动。
        if (clearPixivSuggestions.run(row.id).changes) ids.push(row.id);
        if (isOriginal) {
          const work = catalog.ensureWork('original', now);
          db.prepare('UPDATE images SET original_at=? WHERE id=?').run(now,row.id);
          db.prepare('INSERT OR IGNORE INTO image_copyrights(image_id,work_id,score) VALUES (?,?,NULL)').run(row.id,work.id);
          original++;
          ids.push(row.id);
        }
        for (const tag of result.tags) {
          if (result.automatic) {
            const character = catalog.ensureCharacter(tag, now);
            linkChanges += insert.run(row.id, character.id, now).changes;
            db.prepare('DELETE FROM character_suggestions WHERE image_id=? AND danbooru_tag=?').run(row.id, tag);
          } else {
            const existing = catalog.resolveCharacterId(tag);
            const custom = tag.startsWith(CUSTOM);
            if (custom && existing === null) continue;
            if (existing === null || !db.prepare('SELECT 1 FROM image_characters WHERE image_id=? AND character_id=?').get(row.id,existing))
              suggestionChanges += suggest.run(row.id, tag, custom ? existing : null).changes;
          }
        }
        if (linkChanges || suggestionChanges) ids.push(row.id);
        if (linkChanges) linked++;
        if (suggestionChanges) suggested++;
        complete.run(now,outcome,row.id);
      }
      if (ids.length) applyExclusionRules(ctx, { imageIds: ids });
    })();
    if (ids.length) ctx.touch();
    if (noMatch) unmatched++;
    job.advance(1, summary());
  }
  return summary();
}
