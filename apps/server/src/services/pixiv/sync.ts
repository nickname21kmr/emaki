import { NOT_IN_BOOK } from '../../datasource/sqlite/sql.ts';
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { IN_COMIC_I, QUEUE, QUEUE_KINDS_SQL } from '../../datasource/sqlite/sql.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { DanbooruError } from '../danbooru/client.ts';
import { hasOriginalTag, PixivAccessError, PixivClient, PixivPostError } from './client.ts';
import { createPixivMatcher, type PixivMatcher } from './match.ts';
import type { PixivDiscover } from './discovery.ts';
import { cachedArtwork, cacheArtwork } from './cache.ts';
import { recordChange, type PixivPayload } from '../../datasource/sqlite/changeLog.ts';
import { judgeAutoLink } from '../../domain/curation/auto.ts';
import { linkEach, type LinkItem } from '../../domain/curation/links.ts';
import { auto, RULES } from '../../domain/curation/provenance.ts';

// Pixiv 也能认出动图的角色：动图不进未识别，但这里一起查。
// 漫画页在设置关掉「未识别里也列出漫画页」时不查（QUEUE_KINDS_SQL）
const ELIGIBLE_BASE = `(${QUEUE_KINDS_SQL} OR i.content_kind = 'animated') AND i.shelved_at IS NULL
  AND ${NOT_IN_BOOK} AND NOT ${IN_COMIC_I} AND i.source_site='pixiv' AND i.source_post_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id=i.id)
  AND NOT EXISTS (SELECT 1 FROM character_suggestions cs WHERE cs.image_id=i.id AND cs.source='tagger' AND cs.score>=0.8)
  AND NOT EXISTS (SELECT 1 FROM pixiv_unavailable_posts p WHERE p.post_id=i.source_post_id)`;
const ELIGIBLE = `${ELIGIBLE_BASE} AND i.original_at IS NULL`;
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
  options: { imageIds?: number[]; recheckCached?: boolean } = {},
): Promise<string> {
  const { db } = ctx;
  if (options.recheckCached && options.imageIds === undefined) throw new Error('Rechecking cached Pixiv results requires explicit image IDs');
  // Re-evaluate selected results without clearing the previous check or requesting Pixiv again.
  // Only an intact automatic original mark (same timestamp as its Pixiv check) can be corrected.
  const pending = options.recheckCached ? `${ELIGIBLE_BASE}
    AND EXISTS (SELECT 1 FROM pixiv_artwork_cache a WHERE a.post_id=i.source_post_id)
    AND EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id
      AND p.post_id=i.source_post_id AND (
        (i.original_at IS NULL AND (p.checked_at IS NULL OR p.result='unmatched' OR (
          p.result='suggested' AND EXISTS (SELECT 1 FROM character_suggestions s WHERE s.image_id=i.id)
        ))) OR (p.result='original' AND p.checked_at=i.original_at AND p.modified_at=i.modified_at)
      ))` : PENDING;
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
  const current = db.prepare(`SELECT i.id,i.original_at FROM v_counted_images i WHERE ${pending} AND i.source_post_id=@postId${scope}`);
  // result：linked / original / suggested / unmatched / unavailable / skipped / dismissed，补跑据此决定重不重试
  const complete = db.prepare(`UPDATE pixiv_character_checks SET checked_at=?,result=?,
    modified_at=(SELECT modified_at FROM images WHERE id=pixiv_character_checks.image_id) WHERE image_id=?`);
  const completePost = (id: string, result: string) => db.transaction(() => {
    for (const row of current.all({...scopeParams,postId:id}) as {id:number}[]) complete.run(new Date(ctx.clock()).toISOString(),result,row.id);
  })();
  // 自建角色的建议：danbooru_tag 写伪标签占主键，character_id 写真外键（读的时候看 character_id）
  const suggest = db.prepare("INSERT OR IGNORE INTO character_suggestions (image_id,danbooru_tag,character_id,score,source) VALUES (?,?,?,0,'pixiv')");
  const clearPixivSuggestions = db.prepare("DELETE FROM character_suggestions WHERE image_id=? AND source='pixiv'");
  const vetoed = db.prepare('SELECT 1 FROM character_vetoes WHERE image_id=? AND character_id=?').pluck();
  const liveCustom = db.prepare('SELECT 1 FROM characters WHERE id=? AND danbooru_tag IS NULL');
  const previousSuggestions = options.recheckCached ? db.prepare(`
    SELECT s.source,s.danbooru_tag FROM pixiv_character_checks p
    JOIN character_suggestions s ON s.image_id=p.image_id WHERE p.image_id=? AND p.result='suggested'
  `) : undefined;
  const originalWork = options.recheckCached ? db.prepare(`
    SELECT CAST(o.value ->> 1 AS INTEGER) FROM change_log l, json_each(l.payload,'$.originals') o
    WHERE l.kind='pixiv-sync' AND l.reverted_at IS NULL AND o.value ->> 0 = ?
      AND o.value ->> 2 = ? AND o.value ->> 3 = 1 ORDER BY l.id DESC LIMIT 1
  `).pluck() : undefined;
  const clearOriginal = db.prepare('UPDATE images SET original_at=NULL WHERE id=?');
  const removeOriginalWork = db.prepare('DELETE FROM image_copyrights WHERE image_id=? AND work_id=? AND score IS NULL');
  // 这一轮加的关联和原创标记：结束（包括让出、出错）时记成一条「自动改动」，设置里能撤回
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
          cacheArtwork(db, fetched, new Date(ctx.clock()).toISOString());
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
        db.prepare('INSERT OR IGNORE INTO pixiv_unavailable_posts(post_id,checked_at) VALUES (?,?)')
          .run(post.id,new Date(ctx.clock()).toISOString());
      })();
      unavailable++; job.advance(1, summary()); continue;
    }
    // 请求期间可能有人手动整理角色；重新读取目录与队列，避免覆盖用户的新决定。
    const fresh = makeCatalog();
    const { catalog } = fresh;
    let result = matcher(catalog.verificationRevision)(artwork);
    // 任务期间自建角色可能被合并、删除或编号被新角色占用：伪标签失效就重建索引再匹配（同步执行，写入前不会再变）
    if (result.tags.some((t) => t.startsWith(CUSTOM) && !liveCustom.get(Number(t.slice(CUSTOM.length))))) {
      match = createPixivMatcher(db, fresh.catalog, fresh.copyrights);
      result = match(artwork);
    }
    const isOriginal = result.original;
    const noMatch = !result.tags.length && !isOriginal;
    const outcome = isOriginal ? 'original' : noMatch ? 'unmatched' : result.automatic ? 'linked' : 'suggested';
    const ids: number[] = [];
    const added: Required<PixivPayload> = { links: [], originals: [], correctedOriginals: [] };
    const correctsOriginal = options.recheckCached && !isOriginal && result.tags.length > 0
      && (artwork.isOriginal === true || hasOriginalTag(artwork));
    // 角色、原创、建议的变化由反应套排除规则、重新登记、刷新缓存（job:pixiv-tags 弱刷新）
    ctx.apply(() => {
      const rows = current.all({...scopeParams,postId:post.id}) as { id: number; original_at: string | null }[];
      const now = new Date(ctx.clock()).toISOString();
      for (const row of rows) {
        // 只处理未识别图片，网络请求期间完成的模型/手动关联也不能追加。
        if (db.prepare('SELECT 1 FROM image_characters WHERE image_id=?').get(row.id)) {
          complete.run(now,'skipped',row.id);
          continue;
        }
        const allowed = result.tags.filter(tag => {
          const known = catalog.resolveCharacterId(tag);
          return known === null || vetoed.get(row.id, known) === undefined;
        });
        const previous = previousSuggestions?.all(row.id) as { source: string; danbooru_tag: string }[] | undefined;
        // The primary key can leave a matching model suggestion in place of the Pixiv suggestion.
        if (previous?.length && !previous.some(s => s.source === 'pixiv') &&
          !(result.automatic && previous.some(s => allowed.includes(s.danbooru_tag)))) continue;
        if (row.original_at) {
          if (!correctsOriginal || !allowed.length) continue;
          const work = originalWork?.get(row.id, row.original_at) as number | undefined;
          const removed = work !== undefined && removeOriginalWork.run(row.id, work).changes > 0;
          clearOriginal.run(row.id);
          added.correctedOriginals.push([row.id, row.original_at, now, removed ? work! : null]);
          correctedOriginal++;
          ids.push(row.id);
        }
        let linkChanges = 0, suggestionChanges = 0;
        // 成功取回投稿后才刷新来源建议；失败时保留旧值，同名模型分数也不动。
        if (clearPixivSuggestions.run(row.id).changes) ids.push(row.id);
        if (isOriginal) {
          const work = catalog.ensureWork('original', now);
          db.prepare('UPDATE images SET original_at=? WHERE id=?').run(now,row.id);
          const cw = db.prepare('INSERT OR IGNORE INTO image_copyrights(image_id,work_id,score) VALUES (?,?,NULL)').run(row.id,work.id).changes;
          added.originals.push([row.id, work.id, now, cw ? 1 : 0]);
          original++;
          ids.push(row.id);
        }
        // 能不能自动关联：归类模块的判断（P3a 原样是匹配器的 automatic；P3b 换成 decideAuto）
        const autoLink = judgeAutoLink({ entry: 'pixiv', automatic: result.automatic });
        const links: LinkItem[] = [];
        for (const tag of allowed) {
          if (autoLink) {
            const character = catalog.ensureCharacter(tag, now);
            // 这个标签的建议由 link 一起去掉（证据里的候选就是它）
            links.push({ imageId: row.id, characterId: character.id, provenance: auto(RULES.pixiv, now, { provider: 'pixiv', tag }) });
          } else {
            const existing = catalog.resolveCharacterId(tag);
            const custom = tag.startsWith(CUSTOM);
            if (custom && existing === null) continue;
            if (existing === null || !db.prepare('SELECT 1 FROM image_characters WHERE image_id=? AND character_id=?').get(row.id,existing))
              suggestionChanges += suggest.run(row.id, tag, custom ? existing : null).changes;
          }
        }
        // 自动关联经归类模块写（来历 auto / pixiv@1，否决、建议、角色变化都由它处理）
        for (const l of linkEach(ctx, null, links).linked) {
          added.links.push([l.imageId, l.characterId, now]);
          linkChanges++;
        }
        if (linkChanges || suggestionChanges) ids.push(row.id);
        if (linkChanges) linked++;
        if (suggestionChanges) suggested++;
        complete.run(now,outcome,row.id);
      }
      ctx.changed({ type: 'evidence.changed', provider: 'pixiv', ids });
      ctx.changed({ type: 'curation.originalChanged', ids });
    });
    round.links.push(...added.links);
    round.originals.push(...added.originals);
    round.correctedOriginals.push(...added.correctedOriginals);
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
