import { setTimeout as sleep } from 'node:timers/promises';
import type { JobContext } from '../../core/jobs.ts';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { ART_KINDS_SQL, IN_COMIC_I, QUEUE } from '../../datasource/sqlite/sql.ts';
import { applyExclusionRules } from '../../datasource/sqlite/exclusions.ts';
import type { CharacterCatalog } from '../catalog/characterCatalog.ts';
import type { CopyrightSource } from '../catalog/copyrights.ts';
import { PixivAccessError, PixivClient } from './client.ts';
import { createPixivMatcher } from './match.ts';

const ELIGIBLE = `${ART_KINDS_SQL} AND i.shelved_at IS NULL AND i.original_at IS NULL
  AND i.collection_id IS NULL AND NOT ${IN_COMIC_I} AND i.source_site='pixiv' AND i.source_post_id IS NOT NULL`;
const PENDING = `${ELIGIBLE} AND EXISTS (SELECT 1 FROM pixiv_character_checks p WHERE p.image_id=i.id
  AND p.checked_at IS NULL AND p.post_id=i.source_post_id AND p.modified_at=i.modified_at)`;

/** 模型每批写入后登记首次补充；显式补跑只选未识别队列，并允许重试查过的图片。 */
export function queuePixivImages(ctx: SqliteContext, ids?: number[]): void {
  const automatic = ids !== undefined;
  ctx.db.prepare(`INSERT INTO pixiv_character_checks(image_id,post_id,modified_at)
    SELECT i.id,i.source_post_id,i.modified_at FROM v_counted_images i WHERE ${ELIGIBLE}
    AND ${automatic ? 'i.id IN (SELECT value FROM json_each(?))' : QUEUE}
    ON CONFLICT(image_id) DO UPDATE SET post_id=excluded.post_id,modified_at=excluded.modified_at,checked_at=NULL
    ${automatic ? 'WHERE pixiv_character_checks.post_id<>excluded.post_id OR pixiv_character_checks.modified_at<>excluded.modified_at' : ''}`)
    .run(...(automatic ? [JSON.stringify(ids)] : []));
}

export function pendingPixivCount(ctx: SqliteContext): number {
  return ctx.db.prepare(`SELECT COUNT(*) FROM v_counted_images i WHERE ${PENDING}`).pluck().get() as number;
}

export async function syncPixivCharacters(
  ctx: SqliteContext,
  job: JobContext,
  makeCatalog: () => { catalog: CharacterCatalog; copyrights: CopyrightSource },
  client: Pick<PixivClient, 'artwork'> = new PixivClient(),
  intervalMs = 1000,
): Promise<string> {
  const { db } = ctx;
  const posts = db.prepare(`SELECT DISTINCT i.source_post_id AS id FROM v_counted_images i
    WHERE ${PENDING} ORDER BY i.source_post_id`).all() as { id: string }[];
  job.setTotal(posts.length);
  let linked = 0, suggested = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  const summary = () => `Pixiv 标签：关联 ${linked} 张 · 建议 ${suggested} 张 · 跳过 ${skipped} 个投稿 · 失败 ${failed} 个投稿`;
  if (!posts.length) return summary();
  const initial = makeCatalog();
  const match = createPixivMatcher(db, initial.catalog, initial.copyrights);
  const current = db.prepare(`SELECT i.id FROM v_counted_images i WHERE ${PENDING} AND i.source_post_id=?`);
  const complete = db.prepare(`UPDATE pixiv_character_checks SET checked_at=? WHERE image_id=?`);
  const completePost = (id: string) => db.transaction(() => {
    for (const row of current.all(id) as {id:number}[]) complete.run(new Date(ctx.clock()).toISOString(),row.id);
  })();
  const insert = db.prepare("INSERT OR IGNORE INTO image_characters (image_id,character_id,origin,score,added_at) VALUES (?,?,'tagger',NULL,?)");
  const suggest = db.prepare("INSERT OR IGNORE INTO character_suggestions (image_id,danbooru_tag,score,source) VALUES (?,?,0,'pixiv')");
  for (let n = 0; n < posts.length; n++) {
    job.signal.throwIfAborted();
    if (n && intervalMs) await sleep(intervalMs, undefined, { signal: job.signal });
    const post = posts[n]!;
    job.setMessage(`读取 Pixiv 标签 ${n + 1}/${posts.length} · ${summary()}`);
    let artwork;
    try {
      artwork = await client.artwork(post.id, job.signal);
      consecutiveFailures = 0;
    } catch (error) {
      job.signal.throwIfAborted();
      failed++;
      // 本轮失败留给手动补跑，避免每次扫描自动重复请求不可访问的投稿。
      completePost(post.id);
      if (error instanceof PixivAccessError || ++consecutiveFailures >= 3) throw new Error(`${summary()}；${(error as Error).message}`);
      job.advance(1, summary());
      continue;
    }
    job.signal.throwIfAborted();
    if (!artwork) { completePost(post.id); skipped++; job.advance(1, summary()); continue; }
    // 请求期间可能有人手动整理角色；重新读取目录与队列，避免覆盖用户的新决定。
    const { catalog } = makeCatalog();
    const result = match(artwork);
    if (!result.tags.length) { completePost(post.id); skipped++; job.advance(1, summary()); continue; }
    const ids: number[] = [];
    db.transaction(() => {
      const rows = current.all(post.id) as { id: number }[];
      const now = new Date(ctx.clock()).toISOString();
      for (const row of rows) {
        // 网络请求期间用户手动整理过的图不追加角色。
        if (db.prepare("SELECT 1 FROM image_characters WHERE image_id=? AND origin='manual'").get(row.id)) {
          complete.run(now,row.id);
          continue;
        }
        let changes = 0;
        for (const tag of result.tags) {
          if (result.automatic) {
            const character = catalog.ensureCharacter(tag, now);
            changes += insert.run(row.id, character.id, now).changes;
            db.prepare('DELETE FROM character_suggestions WHERE image_id=? AND danbooru_tag=?').run(row.id, tag);
          } else {
            const existing = catalog.resolveCharacterId(tag);
            if (existing === null || !db.prepare('SELECT 1 FROM image_characters WHERE image_id=? AND character_id=?').get(row.id,existing))
              changes += suggest.run(row.id, tag).changes;
          }
        }
        if (changes) { ids.push(row.id); if (result.automatic) linked++; else suggested++; }
        complete.run(now,row.id);
      }
      if (ids.length) applyExclusionRules(ctx, { imageIds: ids });
    })();
    if (ids.length) ctx.touch();
    job.advance(1, summary());
  }
  return summary();
}
